// Tauri API Invocation Helper
async function invoke(cmd, args = {}) {
  if (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) {
    return await window.__TAURI__.core.invoke(cmd, args);
  } else if (window.__TAURI__ && window.__TAURI__.invoke) {
    return await window.__TAURI__.invoke(cmd, args);
  } else {
    throw new Error("Tauri API not found! Ensure running inside the Tauri shell.");
  }
}

// State Management
let serverUrl = localStorage.getItem("nakama_server_url") || "";
let adminKey = localStorage.getItem("nakama_admin_key") || "";
let catalog = { games: [], modpacks: [] };
let gamesGrouped = {}; // { [title]: { title, versions: [], modpacks: [] } }
let selectedGameTitle = null;
let diskQuota = { total_bytes: 0, used_bytes: 0 };

// File Upload paths (from Rust file picker)
let gameUploadFilePath = null;
let modpackUploadFilePath = null;

// Modal Action states
let confirmAction = null; // Callback for delete confirmation

// ─── UPLOAD TRAY STATE ─────────────────────────────────
// Each entry: { id, label, type, sent, total, status: 'uploading'|'done'|'error', error }
let uploadTrayItems = {};
let uploadTrayCollapsed = false;

// UI Elements Cache
const el = {
  connStatus: document.getElementById("conn-status"),
  connLabel: document.getElementById("conn-label"),
  btnRefresh: document.getElementById("btn-refresh"),
  btnSettings: document.getElementById("btn-settings"),
  btnUploadGame: document.getElementById("btn-upload-game"),
  btnUploadModpack: document.getElementById("btn-upload-modpack"),
  sidebarSearch: document.getElementById("sidebar-search"),
  gameList: document.getElementById("game-list"),
  sidebarLoading: document.getElementById("sidebar-loading"),

  // Views
  viewWelcome: document.getElementById("view-welcome"),
  viewGame: document.getElementById("view-game"),

  // Details View
  detailGameTitle: document.getElementById("detail-game-title"),
  detailGameMeta: document.getElementById("detail-game-meta"),
  btnDeleteAllGame: document.getElementById("btn-delete-all-game"),
  versionsList: document.getElementById("versions-list"),
  modpacksList: document.getElementById("modpacks-list"),

  // Settings Modal
  modalSettings: document.getElementById("modal-settings"),
  settingsClose: document.getElementById("settings-close"),
  settingsCancel: document.getElementById("settings-cancel"),
  settingsSave: document.getElementById("settings-save"),
  inputServerUrl: document.getElementById("input-server-url"),
  inputApiKey: document.getElementById("input-api-key"),

  // Upload Game Modal
  modalUploadGame: document.getElementById("modal-upload-game"),
  uploadGameClose: document.getElementById("upload-game-close"),
  uploadGameCancel: document.getElementById("upload-game-cancel"),
  uploadGameSubmit: document.getElementById("upload-game-submit"),
  ugTitle: document.getElementById("ug-title"),
  ugTitleSuggestions: document.getElementById("ug-title-suggestions"),
  ugVersion: document.getElementById("ug-version"),
  ugExe: document.getElementById("ug-exe"),
  ugDropZone: document.getElementById("ug-drop-zone"),
  ugFileLabel: document.getElementById("ug-file-label"),
  ugStatus: document.getElementById("ug-status"),
  ugBtnText: document.getElementById("ug-btn-text"),

  // Upload Modpack Modal
  modalUploadModpack: document.getElementById("modal-upload-modpack"),
  uploadModpackClose: document.getElementById("upload-modpack-close"),
  uploadModpackCancel: document.getElementById("upload-modpack-cancel"),
  uploadModpackSubmit: document.getElementById("upload-modpack-submit"),
  umGameTitle: document.getElementById("um-game-title"),
  umGameTitleSuggestions: document.getElementById("um-game-title-suggestions"),
  umModpackTitle: document.getElementById("um-modpack-title"),
  umDropZone: document.getElementById("um-drop-zone"),
  umFileLabel: document.getElementById("um-file-label"),
  umStatus: document.getElementById("um-status"),
  umBtnText: document.getElementById("um-btn-text"),

  // Confirm Modal
  modalConfirm: document.getElementById("modal-confirm"),
  confirmClose: document.getElementById("confirm-close"),
  confirmCancel: document.getElementById("confirm-cancel"),
  confirmOk: document.getElementById("confirm-ok"),
  confirmMessage: document.getElementById("confirm-message"),

  // Toast Container
  toastContainer: document.getElementById("toast-container"),

  // Disk Usage
  diskUsage: document.getElementById("disk-usage"),
  diskUsageValue: document.getElementById("disk-usage-value"),
  diskUsageBarFill: document.getElementById("disk-usage-bar-fill"),
  diskUsageDetails: document.getElementById("disk-usage-details"),

  // Upload Tray
  uploadTray: document.getElementById("upload-tray"),
  uploadTrayHeader: document.getElementById("upload-tray-header"),
  uploadTrayBody: document.getElementById("upload-tray-body"),
  uploadTrayBadge: document.getElementById("upload-tray-badge"),
  uploadTrayChevron: document.getElementById("upload-tray-chevron"),
};

// Start App
window.addEventListener("DOMContentLoaded", () => {
  initSettings();
  initEventListeners();
  initUploadTray();

  // Prevent default drag and drop behavior across window
  window.addEventListener("dragover", e => e.preventDefault(), false);
  window.addEventListener("drop", e => e.preventDefault(), false);

  if (serverUrl && adminKey) {
    refreshCatalog();
  } else {
    showSettingsModal();
  }
});

// ─── SETTINGS & CONNECTIVITY ───────────────────────────

function initSettings() {
  el.inputServerUrl.value = serverUrl;
  el.inputApiKey.value = adminKey;
}

function showSettingsModal() {
  el.inputServerUrl.value = serverUrl;
  el.inputApiKey.value = adminKey;
  showModal(el.modalSettings);
}

function hideSettingsModal() {
  hideModal(el.modalSettings);
}

function updateConnectionStatus(isConnected, message = "") {
  if (isConnected) {
    el.connStatus.className = "conn-status conn-status--connected";
    el.connLabel.textContent = "Connected";
  } else {
    el.connStatus.className = "conn-status conn-status--disconnected";
    el.connLabel.textContent = message || "Disconnected";
  }
}

// ─── API OPERATIONS ────────────────────────────────────

async function refreshCatalog() {
  if (!serverUrl || !adminKey) {
    showToast("Server configuration missing! Please configure settings.", "error");
    showSettingsModal();
    return;
  }

  el.sidebarLoading.style.display = "flex";
  // Keep original game list layout, clean out dynamic items
  const items = el.gameList.querySelectorAll(".game-card");
  items.forEach(item => item.remove());

  try {
    const cleanUrl = serverUrl.replace(/\/$/, "");

    // Fetch catalog and disk quota in parallel
    const [catalogText, quotaText] = await Promise.all([
      invoke("server_request", {
        method: "GET",
        url: `${cleanUrl}/query`,
        apiKey: adminKey,
        body: null,
      }),
      invoke("server_request", {
        method: "GET",
        url: `${cleanUrl}/admin/disk-quota`,
        apiKey: adminKey,
        body: null,
      }),
    ]);

    catalog = JSON.parse(catalogText);
    diskQuota = JSON.parse(quotaText);
    groupCatalogData();
    updateConnectionStatus(true);
    renderSidebar();
    renderDiskUsage();

    // Re-render selected details if still active
    if (selectedGameTitle && gamesGrouped[selectedGameTitle]) {
      renderGameDetails(selectedGameTitle);
    } else {
      selectedGameTitle = null;
      el.viewGame.style.display = "none";
      el.viewWelcome.style.display = "flex";
    }
  } catch (err) {
    console.error(err);
    updateConnectionStatus(false, "Connection error");
    showToast(`Failed to connect: ${err}`, "error");
    el.sidebarLoading.style.display = "none";
  }
}

// Group catalog entries by game title
function groupCatalogData() {
  gamesGrouped = {};

  if (catalog.games) {
    catalog.games.forEach(g => {
      const title = g.title;
      if (!gamesGrouped[title]) {
        gamesGrouped[title] = { title, versions: [], modpacks: [] };
      }
      gamesGrouped[title].versions.push(g);
    });
  }

  if (catalog.modpacks) {
    catalog.modpacks.forEach(m => {
      const title = m.game_title;
      if (!gamesGrouped[title]) {
        gamesGrouped[title] = { title, versions: [], modpacks: [] };
      }
      gamesGrouped[title].modpacks.push(m);
    });
  }

  // Sort versions by uploaded date / version string desc
  Object.keys(gamesGrouped).forEach(title => {
    gamesGrouped[title].versions.sort((a, b) => new Date(b.uploaded_at) - new Date(a.uploaded_at));
    gamesGrouped[title].modpacks.sort((a, b) => new Date(b.uploaded_at) - new Date(a.uploaded_at));
  });
}

// ─── RENDERING FRONTEND ────────────────────────────────

function renderSidebar() {
  el.sidebarLoading.style.display = "none";
  const filter = el.sidebarSearch.value.toLowerCase().trim();

  // Remove existing cards
  const existingCards = el.gameList.querySelectorAll(".game-card");
  existingCards.forEach(c => c.remove());

  const sortedTitles = Object.keys(gamesGrouped).sort((a, b) => a.localeCompare(b));

  let displayedCount = 0;

  sortedTitles.forEach(title => {
    if (filter && !title.toLowerCase().includes(filter)) {
      return;
    }
    displayedCount++;

    const entry = gamesGrouped[title];
    const card = document.createElement("div");
    card.className = `game-card ${selectedGameTitle === title ? "active" : ""}`;
    card.onclick = () => selectGame(title);

    const vCount = entry.versions.length;
    const mCount = entry.modpacks.length;
    const metaText = `${vCount} version${vCount !== 1 ? "s" : ""}, ${mCount} modpack${mCount !== 1 ? "s" : ""}`;

    card.innerHTML = `
      <div class="game-card-icon">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>
        </svg>
      </div>
      <div class="game-card-info">
        <div class="game-card-name" title="${escapeHtml(title)}">${escapeHtml(title)}</div>
        <div class="game-card-meta">${metaText}</div>
      </div>
    `;
    el.gameList.appendChild(card);
  });

  if (displayedCount === 0) {
    const emptyState = document.createElement("div");
    emptyState.className = "game-card";
    emptyState.style.cursor = "default";
    emptyState.style.background = "transparent";
    emptyState.innerHTML = `
      <div style="font-size:0.8rem;color:var(--c-text-3);text-align:center;width:100%;padding:1rem 0">
        ${filter ? "No matching games" : "No games found"}
      </div>
    `;
    el.gameList.appendChild(emptyState);
  }
}

function renderDiskUsage() {
  const { total_bytes, used_bytes } = diskQuota;

  if (total_bytes === 0 || used_bytes === 0) {
    el.diskUsage.style.display = "none";
    return;
  }

  // Calculate used from catalog for breakdown details
  let totalGamesBytes = 0;
  let totalModpacksBytes = 0;

  if (catalog.games) {
    catalog.games.forEach(g => {
      totalGamesBytes += g.file_size_bytes || 0;
    });
  }
  if (catalog.modpacks) {
    catalog.modpacks.forEach(m => {
      totalModpacksBytes += m.file_size_bytes || 0;
    });
  }

  el.diskUsage.style.display = "flex";

  // Show "used / total" in the header
  el.diskUsageValue.textContent = `${formatBytes(used_bytes)} / ${formatBytes(total_bytes)}`;

  // Fill bar proportional to usage vs quota
  const ratio = Math.min(used_bytes / total_bytes, 1);
  const percent = Math.round(ratio * 100);
  const barFill = el.diskUsageBarFill;
  barFill.className = "disk-usage-bar-fill";
  barFill.style.width = `${percent}%`;

  // Color by usage ratio: green < 50%, yellow < 80%, orange < 95%, red >= 95%
  if (ratio < 0.5) {
    barFill.classList.add("disk-usage-bar-fill--low");
  } else if (ratio < 0.8) {
    barFill.classList.add("disk-usage-bar-fill--medium");
  } else {
    barFill.classList.add("disk-usage-bar-fill--high");
  }

  // Build breakdown text
  const parts = [];
  if (totalGamesBytes > 0) {
    parts.push(`<span><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>${formatBytes(totalGamesBytes)} games</span>`);
  }
  if (totalModpacksBytes > 0) {
    parts.push(`<span><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>${formatBytes(totalModpacksBytes)} modpacks</span>`);
  }

  // Calculate and display free space
  const freeBytes = Math.max(total_bytes - used_bytes, 0);
  let freeStatusClass = "disk-usage-free--success";
  let freeIcon = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>`;

  if (ratio >= 0.8) {
    freeStatusClass = "disk-usage-free--danger";
    freeIcon = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`;
  } else if (ratio >= 0.5) {
    freeStatusClass = "disk-usage-free--warning";
    freeIcon = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`;
  }

  parts.push(`<span class="disk-usage-free ${freeStatusClass}">${freeIcon}${formatBytes(freeBytes)} free</span>`);

  el.diskUsageDetails.innerHTML = parts.join("");
}

function selectGame(title) {
  selectedGameTitle = title;

  // Update active sidebar cards
  const cards = el.gameList.querySelectorAll(".game-card");
  cards.forEach(c => {
    const nameEl = c.querySelector(".game-card-name");
    if (nameEl && nameEl.textContent === title) {
      c.classList.add("active");
    } else {
      c.classList.remove("active");
    }
  });

  renderGameDetails(title);
}

function renderGameDetails(title) {
  const entry = gamesGrouped[title];
  if (!entry) return;

  el.viewWelcome.style.display = "none";
  el.viewGame.style.display = "flex";

  el.detailGameTitle.textContent = title;
  el.detailGameMeta.textContent = `${entry.versions.length} version(s), ${entry.modpacks.length} modpack(s) registered.`;

  // Render Versions List
  el.versionsList.innerHTML = "";
  if (entry.versions.length === 0) {
    el.versionsList.innerHTML = `<div class="list-state" style="padding:1.5rem">No versions uploaded yet.</div>`;
  } else {
    entry.versions.forEach(v => {
      const row = document.createElement("div");
      row.className = "entry-row";
      row.innerHTML = `
        <div class="entry-info">
          <div class="entry-primary">
            v${escapeHtml(v.version)}
            ${v.launch_exe ? `<span style="font-size:0.72rem;color:var(--c-accent);border:1px solid rgba(99,102,241,0.3);padding:1px 5px;border-radius:3px;font-weight:normal">launch: ${escapeHtml(v.launch_exe)}</span>` : ""}
          </div>
          <div class="entry-secondary">
            <span>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
              ${formatBytes(v.file_size_bytes)}
            </span>
            <span>•</span>
            <span>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
              ${(v.downloads ?? 0).toLocaleString()} download${v.downloads !== 1 ? "s" : ""}
            </span>
            <span>•</span>
            <span>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
              Uploaded: ${new Date(v.uploaded_at).toLocaleString()}
            </span>
          </div>
        </div>
        <div class="entry-actions">
          <button class="btn-icon-danger" title="Delete this version" onclick="confirmDeleteVersion('${escapeJsString(title)}', '${escapeJsString(v.version)}')">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/>
            </svg>
          </button>
        </div>
      `;
      el.versionsList.appendChild(row);
    });
  }

  // Render Modpacks List
  el.modpacksList.innerHTML = "";
  if (entry.modpacks.length === 0) {
    el.modpacksList.innerHTML = `<div class="list-state" style="padding:1.5rem">No modpacks uploaded yet.</div>`;
  } else {
    entry.modpacks.forEach(m => {
      const row = document.createElement("div");
      row.className = "entry-row";
      row.innerHTML = `
        <div class="entry-info">
          <div class="entry-primary">${escapeHtml(m.modpack_title)}</div>
          <div class="entry-secondary">
            <span>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
              ${formatBytes(m.file_size_bytes)}
            </span>
            <span>•</span>
            <span>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
              ${(m.downloads ?? 0).toLocaleString()} download${m.downloads !== 1 ? "s" : ""}
            </span>
            <span>•</span>
            <span>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
              Uploaded: ${new Date(m.uploaded_at).toLocaleString()}
            </span>
          </div>
        </div>
        <div class="entry-actions">
          <button class="btn-icon-danger" title="Delete this modpack" onclick="confirmDeleteModpack('${escapeJsString(title)}', '${escapeJsString(m.modpack_title)}')">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/>
            </svg>
          </button>
        </div>
      `;
      el.modpacksList.appendChild(row);
    });
  }

  // Deleting entire game
  el.btnDeleteAllGame.onclick = () => {
    confirmDeleteAllGame(title);
  };
}

// ─── DELETIONS ─────────────────────────────────────────

window.confirmDeleteVersion = function(title, version) {
  el.confirmMessage.innerHTML = `Are you sure you want to permanently delete <strong>${escapeHtml(title)}</strong> version <strong>v${escapeHtml(version)}</strong>?<br/><br/>This file will be deleted from disk and cataloged records. This action is permanent.`;
  confirmAction = async () => {
    try {
      const cleanUrl = serverUrl.replace(/\/$/, "");
      await invoke("server_request", {
        method: "DELETE",
        url: `${cleanUrl}/admin/game/${encodeURIComponent(title)}/${encodeURIComponent(version)}`,
        apiKey: adminKey,
        body: null,
      });
      showToast(`Successfully deleted version ${version}`, "success");
      refreshCatalog();
    } catch (err) {
      showToast(`Failed to delete version: ${err}`, "error");
    }
  };
  showModal(el.modalConfirm);
};

window.confirmDeleteModpack = function(gameTitle, modpackTitle) {
  el.confirmMessage.innerHTML = `Are you sure you want to permanently delete the modpack <strong>${escapeHtml(modpackTitle)}</strong> for <strong>${escapeHtml(gameTitle)}</strong>?<br/><br/>This file will be deleted from disk and cataloged records. This action is permanent.`;
  confirmAction = async () => {
    try {
      const cleanUrl = serverUrl.replace(/\/$/, "");
      await invoke("server_request", {
        method: "DELETE",
        url: `${cleanUrl}/admin/modpack/${encodeURIComponent(gameTitle)}/${encodeURIComponent(modpackTitle)}`,
        apiKey: adminKey,
        body: null,
      });
      showToast(`Successfully deleted modpack ${modpackTitle}`, "success");
      refreshCatalog();
    } catch (err) {
      showToast(`Failed to delete modpack: ${err}`, "error");
    }
  };
  showModal(el.modalConfirm);
};

function confirmDeleteAllGame(title) {
  const entry = gamesGrouped[title];
  if (!entry) return;

  const totalVersions = entry.versions.length;
  const totalModpacks = entry.modpacks.length;

  el.confirmMessage.innerHTML = `
    Are you sure you want to permanently delete the entire game <strong>${escapeHtml(title)}</strong>?<br/><br/>
    This will delete:<br/>
    • <strong>${totalVersions}</strong> versions<br/>
    • <strong>${totalModpacks}</strong> modpacks<br/><br/>
    This is permanent and will execute consecutive deletions.
  `;

  confirmAction = async () => {
    let successCount = 0;
    let failCount = 0;
    const cleanUrl = serverUrl.replace(/\/$/, "");

    // Delete all versions
    for (let v of entry.versions) {
      try {
        await invoke("server_request", {
          method: "DELETE",
          url: `${cleanUrl}/admin/game/${encodeURIComponent(title)}/${encodeURIComponent(v.version)}`,
          apiKey: adminKey,
          body: null,
        });
        successCount++;
      } catch (err) {
        console.error(err);
        failCount++;
      }
    }

    // Delete all modpacks
    for (let m of entry.modpacks) {
      try {
        await invoke("server_request", {
          method: "DELETE",
          url: `${cleanUrl}/admin/modpack/${encodeURIComponent(title)}/${encodeURIComponent(m.modpack_title)}`,
          apiKey: adminKey,
          body: null,
        });
        successCount++;
      } catch (err) {
        console.error(err);
        failCount++;
      }
    }

    if (failCount === 0) {
      showToast(`Successfully deleted game "${title}" completely`, "success");
      selectedGameTitle = null;
    } else {
      showToast(`Deleted game with some errors (${successCount} succeeded, ${failCount} failed)`, "warning");
    }

    refreshCatalog();
  };
  showModal(el.modalConfirm);
}

// ─── FUZZY SEARCH MATCHES ──────────────────────────────

function setupFuzzySearch(inputEl, suggestionsEl, getExistingList) {
  inputEl.addEventListener("input", () => {
    const value = inputEl.value.trim().toLowerCase();
    const existingList = getExistingList();

    if (!value) {
      suggestionsEl.style.display = "none";
      return;
    }

    const matches = existingList.filter(item => item.toLowerCase().includes(value));

    if (matches.length === 0) {
      suggestionsEl.innerHTML = `<div class="fuzzy-no-results">No matches found</div>`;
    } else {
      suggestionsEl.innerHTML = matches
        .map(match => `<div class="fuzzy-item" onclick="selectFuzzySuggestion('${escapeJsString(inputEl.id)}', '${escapeJsString(match)}')">${escapeHtml(match)}</div>`)
        .join("");
    }
    suggestionsEl.style.display = "block";
  });

  // Hide list on blur (after tiny delay so click fires first)
  inputEl.addEventListener("blur", () => {
    setTimeout(() => {
      suggestionsEl.style.display = "none";
    }, 200);
  });
}

window.selectFuzzySuggestion = function(inputId, val) {
  const inputEl = document.getElementById(inputId);
  if (inputEl) {
    inputEl.value = val;
    // Trigger input event to re-evaluate state if needed
    inputEl.dispatchEvent(new Event("change"));
  }
};

function getUniqueGameTitles() {
  return Object.keys(gamesGrouped);
}

// ─── FILE SELECTION ────────────────────────────────────

async function pickFile(zoneId, labelId, uploadType) {
  try {
    const path = await invoke("select_zip_file");
    if (path) {
      const filename = path.split(/[/\\]/).pop();
      document.getElementById(labelId).textContent = filename;
      document.getElementById(zoneId).classList.add("file-selected");

      if (uploadType === "game") {
        gameUploadFilePath = path;
      } else {
        modpackUploadFilePath = path;
      }
    }
  } catch (err) {
    showToast(`Failed to pick file: ${err}`, "error");
  }
}

// ─── UPLOADS ───────────────────────────────────────────

async function handleGameUpload() {
  const title = el.ugTitle.value.trim();
  const version = el.ugVersion.value.trim();
  const launchExe = el.ugExe.value.trim();

  if (!title || !version || !launchExe) {
    setUploadStatus(el.ugStatus, "Please fill in all fields.", "error");
    return;
  }

  if (!gameUploadFilePath) {
    setUploadStatus(el.ugStatus, "Please select a ZIP file.", "error");
    return;
  }

  const uploadId = `upload-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const label = `${title} v${version}`;
  const filePath = gameUploadFilePath;

  // Register in tray and dismiss modal immediately
  trayAddItem(uploadId, label, "game");
  hideModal(el.modalUploadGame);
  resetGameUploadForm();

  // Fire-and-forget background upload
  (async () => {
    try {
      const cleanUrl = serverUrl.replace(/\/$/, "");
      await invoke("upload_game", {
        serverUrl: cleanUrl,
        adminKey,
        title,
        version,
        launchExe,
        filePath,
        uploadId,
      });
      trayItemDone(uploadId);
      showToast(`Uploaded ${label}!`, "success");
      refreshCatalog();
    } catch (err) {
      console.error(err);
      // If we were in 'cancelling' state the stream error is expected
      if (uploadTrayItems[uploadId]?.status === "cancelling") {
        trayItemCancelled(uploadId);
      } else {
        trayItemError(uploadId, String(err));
        showToast(`Upload failed: ${label}`, "error");
      }
    }
  })();
}

async function handleModpackUpload() {
  const gameTitle = el.umGameTitle.value.trim();
  const modpackTitle = el.umModpackTitle.value.trim();

  if (!gameTitle || !modpackTitle) {
    setUploadStatus(el.umStatus, "Please fill in all fields.", "error");
    return;
  }

  if (!modpackUploadFilePath) {
    setUploadStatus(el.umStatus, "Please select a ZIP file.", "error");
    return;
  }

  const uploadId = `upload-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const label = `${modpackTitle} (${gameTitle})`;
  const filePath = modpackUploadFilePath;

  // Register in tray and dismiss modal immediately
  trayAddItem(uploadId, label, "modpack");
  hideModal(el.modalUploadModpack);
  resetModpackUploadForm();

  // Fire-and-forget background upload
  (async () => {
    try {
      const cleanUrl = serverUrl.replace(/\/$/, "");
      await invoke("upload_modpack", {
        serverUrl: cleanUrl,
        adminKey,
        gameTitle,
        modpackTitle,
        filePath,
        uploadId,
      });
      trayItemDone(uploadId);
      showToast(`Uploaded modpack "${modpackTitle}"!`, "success");
      refreshCatalog();
    } catch (err) {
      console.error(err);
      // If we were in 'cancelling' state the stream error is expected
      if (uploadTrayItems[uploadId]?.status === "cancelling") {
        trayItemCancelled(uploadId);
      } else {
        trayItemError(uploadId, String(err));
        showToast(`Upload failed: ${modpackTitle}`, "error");
      }
    }
  })();
}

function setUploadStatus(statusEl, text, type) {
  statusEl.style.display = "block";
  statusEl.className = `upload-status upload-status--${type}`;
  statusEl.innerHTML = text;
}

function setUploadLoading(statusEl, btnEl, text) {
  statusEl.style.display = "block";
  statusEl.className = "upload-status upload-status--loading";
  statusEl.innerHTML = `
    <svg class="animate-spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
    </svg>
    Uploading file. Please do not close NakamaAdmin. This can take a while for large games.
  `;
  btnEl.textContent = text;
  btnEl.disabled = true;
}

function resetUploadButton(btnEl, text) {
  btnEl.textContent = text;
  btnEl.disabled = false;
}

function resetGameUploadForm() {
  el.ugTitle.value = "";
  el.ugVersion.value = "";
  el.ugExe.value = "";
  gameUploadFilePath = null;
  el.ugFileLabel.textContent = "Click to select ZIP file";
  el.ugDropZone.className = "file-drop-zone";
  el.ugStatus.style.display = "none";
  resetUploadButton(el.ugBtnText, "Upload Game");
}

function resetModpackUploadForm() {
  el.umGameTitle.value = "";
  el.umModpackTitle.value = "";
  modpackUploadFilePath = null;
  el.umFileLabel.textContent = "Click to select ZIP file";
  el.umDropZone.className = "file-drop-zone";
  el.umStatus.style.display = "none";
  resetUploadButton(el.umBtnText, "Upload Modpack");
}

// ─── EVENT LISTENERS ───────────────────────────────────

function initEventListeners() {
  // Settings Button
  el.btnSettings.onclick = () => showSettingsModal();
  el.settingsClose.onclick = () => hideSettingsModal();
  el.settingsCancel.onclick = () => hideSettingsModal();
  el.settingsSave.onclick = () => {
    const url = el.inputServerUrl.value.trim();
    const key = el.inputApiKey.value.trim();
    if (!url || !key) {
      showToast("Please fill in both fields.", "error");
      return;
    }
    serverUrl = url;
    adminKey = key;
    localStorage.setItem("nakama_server_url", url);
    localStorage.setItem("nakama_admin_key", key);
    hideSettingsModal();
    refreshCatalog();
  };

  // Refresh Button
  el.btnRefresh.onclick = () => refreshCatalog();

  // Sidebar filter
  el.sidebarSearch.addEventListener("input", () => renderSidebar());

  // Upload Game Button & Modal
  el.btnUploadGame.onclick = () => {
    resetGameUploadForm();
    showModal(el.modalUploadGame);
  };
  el.uploadGameClose.onclick = () => hideModal(el.modalUploadGame);
  el.uploadGameCancel.onclick = () => hideModal(el.modalUploadGame);
  el.ugDropZone.onclick = () => pickFile("ug-drop-zone", "ug-file-label", "game");
  el.uploadGameSubmit.onclick = () => handleGameUpload();

  // Upload Modpack Button & Modal
  el.btnUploadModpack.onclick = () => {
    resetModpackUploadForm();
    showModal(el.modalUploadModpack);
  };
  el.uploadModpackClose.onclick = () => hideModal(el.modalUploadModpack);
  el.uploadModpackCancel.onclick = () => hideModal(el.modalUploadModpack);
  el.umDropZone.onclick = () => pickFile("um-drop-zone", "um-file-label", "modpack");
  el.uploadModpackSubmit.onclick = () => handleModpackUpload();

  // Confirm Modal
  el.confirmClose.onclick = () => hideModal(el.modalConfirm);
  el.confirmCancel.onclick = () => hideModal(el.modalConfirm);
  el.confirmOk.onclick = async () => {
    hideModal(el.modalConfirm);
    if (confirmAction) {
      await confirmAction();
      confirmAction = null;
    }
  };

  // Setup fuzzy search dropdowns
  setupFuzzySearch(el.ugTitle, el.ugTitleSuggestions, getUniqueGameTitles);
  setupFuzzySearch(el.umGameTitle, el.umGameTitleSuggestions, getUniqueGameTitles);
}

// ─── UPLOAD TRAY ────────────────────────────────────────

function initUploadTray() {
  // Subscribe to progress events emitted by Rust
  if (window.__TAURI__ && window.__TAURI__.event) {
    window.__TAURI__.event.listen("upload://progress", ({ payload }) => {
      trayItemProgress(payload.id, payload.sent, payload.total);
    });
  }
  // Toggle collapse on header click
  el.uploadTrayHeader.addEventListener("click", () => {
    uploadTrayCollapsed = !uploadTrayCollapsed;
    el.uploadTrayBody.classList.toggle("upload-tray-body--collapsed", uploadTrayCollapsed);
    el.uploadTrayChevron.classList.toggle("upload-tray-chevron--collapsed", uploadTrayCollapsed);
  });
}

function trayAddItem(id, label, type) {
  uploadTrayItems[id] = { id, label, type, sent: 0, total: 0, status: "uploading" };
  renderTray();
  // Auto-expand when a new upload starts
  uploadTrayCollapsed = false;
  el.uploadTrayBody.classList.remove("upload-tray-body--collapsed");
  el.uploadTrayChevron.classList.remove("upload-tray-chevron--collapsed");
}

function trayItemProgress(id, sent, total) {
  if (!uploadTrayItems[id]) return;
  uploadTrayItems[id].sent = sent;
  uploadTrayItems[id].total = total;
  updateTrayItem(id);
  updateTrayHeader();
}

function trayItemDone(id) {
  if (!uploadTrayItems[id]) return;
  uploadTrayItems[id].status = "done";
  uploadTrayItems[id].sent = uploadTrayItems[id].total;
  updateTrayItem(id);
  updateTrayHeader();
}

function trayItemError(id, errMsg) {
  if (!uploadTrayItems[id]) return;
  uploadTrayItems[id].status = "error";
  uploadTrayItems[id].error = errMsg;
  updateTrayItem(id);
  updateTrayHeader();
}

function trayItemCancelled(id) {
  if (!uploadTrayItems[id]) return;
  uploadTrayItems[id].status = "cancelled";
  updateTrayItem(id);
  updateTrayHeader();
}

async function cancelUpload(id) {
  const item = uploadTrayItems[id];
  if (!item || item.status !== "uploading") return;
  uploadTrayItems[id].status = "cancelling";
  updateTrayItem(id);
  updateTrayHeader();
  try {
    await invoke("cancel_upload", { uploadId: id });
  } catch (e) {
    console.error("cancel_upload failed:", e);
    if (uploadTrayItems[id]?.status === "cancelling") {
      uploadTrayItems[id].status = "uploading";
      updateTrayItem(id);
      updateTrayHeader();
    }
  }
}

function dismissUpload(id) {
  delete uploadTrayItems[id];
  const itemEl = document.getElementById(`tray-item-${id}`);
  if (itemEl) itemEl.remove();
  if (Object.keys(uploadTrayItems).length === 0) {
    el.uploadTray.style.display = "none";
  }
  updateTrayHeader();
}

function renderTray() {
  el.uploadTray.style.display = "block";
  const id = Object.keys(uploadTrayItems).pop();
  if (!id) return;
  const item = uploadTrayItems[id];
  const itemEl = createTrayItemEl(item);
  el.uploadTrayBody.appendChild(itemEl);
  updateTrayHeader();
}

function createTrayItemEl(item) {
  const div = document.createElement("div");
  div.className = "upload-item";
  div.id = `tray-item-${item.id}`;
  div.innerHTML = trayItemHTML(item);
  // Attach button listeners once — never lost because updateTrayItem
  // updates individual DOM elements instead of replacing innerHTML.
  const cancelBtn = div.querySelector(`#cancel-btn-${item.id}`);
  if (cancelBtn) cancelBtn.addEventListener("click", () => cancelUpload(item.id));
  const dismissBtn = div.querySelector(`#dismiss-btn-${item.id}`);
  if (dismissBtn) dismissBtn.addEventListener("click", () => dismissUpload(item.id));
  return div;
}

function trayItemHTML(item) {
  const pct = item.total > 0 ? Math.round((item.sent / item.total) * 100) : 0;
  const isDone       = item.status === "done";
  const isError      = item.status === "error";
  const isCancelled  = item.status === "cancelled";
  const isCancelling = item.status === "cancelling";
  const isUploading  = item.status === "uploading";

  // Progress bar class
  const fillClass = isDone
    ? "upload-item-progress-fill upload-item-progress-fill--done"
    : isError
    ? "upload-item-progress-fill upload-item-progress-fill--error"
    : isCancelled
    ? "upload-item-progress-fill upload-item-progress-fill--cancelled"
    : isCancelling
    ? "upload-item-progress-fill upload-item-progress-fill--cancelling"
    : item.total === 0
    ? "upload-item-progress-fill upload-item-progress-fill--indeterminate"
    : "upload-item-progress-fill";

  const fillStyle = (!isDone && !isError && !isCancelled && !isCancelling && item.total > 0)
    ? `style="width:${pct}%"`
    : "";

  // Status line
  let statusText;
  if (isDone) {
    statusText = `<span class="upload-item-status upload-item-status--done">
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
      Done
    </span>`;
  } else if (isError) {
    statusText = `<span class="upload-item-status upload-item-status--error">
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
      Failed
    </span>`;
  } else if (isCancelled) {
    statusText = `<span class="upload-item-status upload-item-status--cancelled">
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
      Cancelled
    </span>`;
  } else if (isCancelling) {
    statusText = `<span class="upload-item-status upload-item-status--cancelling">
      <svg class="animate-spin" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
      Cancelling…
    </span>`;
  } else {
    const sentStr = item.total > 0
      ? `${formatBytes(item.sent)} / ${formatBytes(item.total)} (${pct}%)`
      : "Preparing…";
    statusText = `<span class="upload-item-status">${sentStr}</span>`;
  }

  // Both buttons rendered; one hidden via inline style. updateTrayItem swaps visibility.
  const actionBtns = `
    <button class="upload-item-cancel" id="cancel-btn-${item.id}" title="Cancel upload" style="${isUploading ? '' : 'display:none'}">
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      Cancel
    </button>
    <button class="upload-item-dismiss" id="dismiss-btn-${item.id}" title="Dismiss" style="${isUploading ? 'display:none' : ''}">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    </button>`;

  return `
    <div class="upload-item-header">
      <span class="upload-item-name" title="${escapeHtml(item.label)}">${escapeHtml(item.label)}</span>
      <span class="upload-item-type upload-item-type--${item.type}">${item.type === "game" ? "Game" : "Mod"}</span>
      ${actionBtns}
    </div>
    <div class="upload-item-progress-track">
      <div id="fill-${item.id}" class="${fillClass}" ${fillStyle}></div>
    </div>
    <span id="status-${item.id}">${statusText}</span>
  `;
}

function updateTrayItem(id) {
  const itemEl = document.getElementById(`tray-item-${id}`);
  if (!itemEl) return;
  const item = uploadTrayItems[id];
  if (!item) return;
  const s = item.status;

  // Update item border class
  itemEl.className = "upload-item"
    + (s === "done"      ? " upload-item--done"      : "")
    + (s === "error"     ? " upload-item--error"     : "")
    + (s === "cancelled" ? " upload-item--cancelled" : "");

  // Update progress fill
  const fill = document.getElementById(`fill-${id}`);
  if (fill) {
    const pct = item.total > 0 ? Math.round((item.sent / item.total) * 100) : 0;
    const fillClass = s === "done"
      ? "upload-item-progress-fill upload-item-progress-fill--done"
      : s === "error"
      ? "upload-item-progress-fill upload-item-progress-fill--error"
      : s === "cancelled"
      ? "upload-item-progress-fill upload-item-progress-fill--cancelled"
      : s === "cancelling"
      ? "upload-item-progress-fill upload-item-progress-fill--cancelling"
      : item.total === 0
      ? "upload-item-progress-fill upload-item-progress-fill--indeterminate"
      : "upload-item-progress-fill";
    fill.className = fillClass;
    if (s === "uploading" && item.total > 0) {
      fill.style.width = `${pct}%`;
    } else {
      fill.style.width = "";
    }
  }

  // Update status text
  const statusEl = document.getElementById(`status-${id}`);
  if (statusEl) {
    const pct = item.total > 0 ? Math.round((item.sent / item.total) * 100) : 0;
    if (s === "done") {
      statusEl.className = "upload-item-status upload-item-status--done";
      statusEl.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Done`;
    } else if (s === "error") {
      statusEl.className = "upload-item-status upload-item-status--error";
      statusEl.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg> Failed`;
    } else if (s === "cancelled") {
      statusEl.className = "upload-item-status upload-item-status--cancelled";
      statusEl.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg> Cancelled`;
    } else if (s === "cancelling") {
      statusEl.className = "upload-item-status upload-item-status--cancelling";
      statusEl.innerHTML = `<svg class="animate-spin" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg> Cancelling…`;
    } else {
      statusEl.className = "upload-item-status";
      const sentStr = item.total > 0
        ? `${formatBytes(item.sent)} / ${formatBytes(item.total)} (${pct}%)`
        : "Preparing…";
      statusEl.textContent = sentStr;
    }
  }

  // Swap button visibility: cancel only while uploading, dismiss otherwise
  const cancelBtn = document.getElementById(`cancel-btn-${id}`);
  const dismissBtn = document.getElementById(`dismiss-btn-${id}`);
  const showCancel = s === "uploading";
  if (cancelBtn) cancelBtn.style.display = showCancel ? "" : "none";
  if (dismissBtn) dismissBtn.style.display = showCancel ? "none" : "";
}

function updateTrayHeader() {
  const items = Object.values(uploadTrayItems);
  const active = items.filter(i => i.status === "uploading" || i.status === "cancelling").length;
  const total = items.length;
  el.uploadTrayBadge.textContent = total;
  el.uploadTrayBadge.className = active === 0 && total > 0
    ? "upload-tray-badge upload-tray-badge--done"
    : "upload-tray-badge";
}

// ─── UTILITIES & HELPERS ────────────────────────────────

function showModal(modalEl) {
  modalEl.style.display = "flex";
}

function hideModal(modalEl) {
  modalEl.style.display = "none";
}

function showToast(message, type = "success") {
  const toast = document.createElement("div");
  toast.className = `toast toast--${type}`;

  const icon = type === "success" 
    ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`
    : `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`;

  toast.innerHTML = `
    ${icon}
    <span>${escapeHtml(message)}</span>
  `;

  el.toastContainer.appendChild(toast);

  // Automatically fade out and delete
  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateX(50px)";
    toast.style.transition = "opacity 0.2s, transform 0.2s";
    setTimeout(() => toast.remove(), 200);
  }, 4000);
}

function formatBytes(bytes, decimals = 2) {
  if (!+bytes) return "0 Bytes";
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ["Bytes", "KiB", "MiB", "GiB", "TiB", "PiB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

function escapeHtml(str) {
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeJsString(str) {
  if (!str) return "";
  return str.replace(/'/g, "\\'").replace(/"/g, '\\"');
}
