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
};

// Start App
window.addEventListener("DOMContentLoaded", () => {
  initSettings();
  initEventListeners();

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

  setUploadLoading(el.ugStatus, el.ugBtnText, "Uploading…");

  try {
    const cleanUrl = serverUrl.replace(/\/$/, "");
    await invoke("upload_game", {
      serverUrl: cleanUrl,
      adminKey,
      title,
      version,
      launchExe,
      filePath: gameUploadFilePath,
    });

    showToast(`Successfully uploaded ${title} v${version}!`, "success");
    hideModal(el.modalUploadGame);
    resetGameUploadForm();
    refreshCatalog();
  } catch (err) {
    console.error(err);
    setUploadStatus(el.ugStatus, `Upload failed: ${err}`, "error");
    resetUploadButton(el.ugBtnText, "Upload Game");
  }
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

  setUploadLoading(el.umStatus, el.umBtnText, "Uploading…");

  try {
    const cleanUrl = serverUrl.replace(/\/$/, "");
    await invoke("upload_modpack", {
      serverUrl: cleanUrl,
      adminKey,
      gameTitle,
      modpackTitle,
      filePath: modpackUploadFilePath,
    });

    showToast(`Successfully uploaded modpack "${modpackTitle}"!`, "success");
    hideModal(el.modalUploadModpack);
    resetModpackUploadForm();
    refreshCatalog();
  } catch (err) {
    console.error(err);
    setUploadStatus(el.umStatus, `Upload failed: ${err}`, "error");
    resetUploadButton(el.umBtnText, "Upload Modpack");
  }
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
