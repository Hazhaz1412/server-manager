const DEFAULT_API_URL = "YOUR_API_GATEWAY";
const REFRESH_INTERVAL = 30000;
const STATUS_CACHE_TTL = 60000;
const STATUS_CACHE_KEY = "blockops_status_cache";

const state = {
    apiUrl: localStorage.getItem("blockops_api_url") || DEFAULT_API_URL,
    apiToken: localStorage.getItem("blockops_api_token") || "",
    status: "loading",
    pendingAction: null,
    isRefreshing: false,
    activities: []
};

const elements = {
    serverStatus: document.getElementById("serverStatus"),
    statusOrb: document.getElementById("statusOrb"),
    serverAddress: document.getElementById("serverAddress"),
    playerCount: document.getElementById("playerCount"),
    uptime: document.getElementById("uptime"),
    serverVersion: document.getElementById("serverVersion"),
    lastUpdate: document.getElementById("lastUpdate"),
    connectionPill: document.getElementById("connectionPill"),
    connectionText: document.getElementById("connectionText"),
    refreshButton: document.getElementById("refreshButton"),
    startButton: document.getElementById("startButton"),
    stopButton: document.getElementById("stopButton"),
    restartInstanceButton: document.getElementById("restartInstanceButton"),
    restartServerButton: document.getElementById("restartServerButton"),
    copyButton: document.getElementById("copyButton"),
    activityList: document.getElementById("activityList"),
    clearLogButton: document.getElementById("clearLogButton"),
    confirmModal: document.getElementById("confirmModal"),
    confirmTitle: document.getElementById("confirmTitle"),
    confirmMessage: document.getElementById("confirmMessage"),
    confirmAction: document.getElementById("confirmAction"),
    cancelAction: document.getElementById("cancelAction"),
    settingsButton: document.getElementById("settingsButton"),
    settingsModal: document.getElementById("settingsModal"),
    closeSettings: document.getElementById("closeSettings"),
    apiUrlInput: document.getElementById("apiUrlInput"),
    apiTokenInput: document.getElementById("apiTokenInput"),
    saveApiUrl: document.getElementById("saveApiUrl"),
    resetApiUrl: document.getElementById("resetApiUrl"),
    toastRegion: document.getElementById("toastRegion")
};

const statusLabels = {
    running: "Đang hoạt động",
    online: "Đang hoạt động",
    started: "Đang hoạt động",
    pending: "Đang khởi động",
    starting: "Đang khởi động",
    stopping: "Đang tắt",
    rebooting: "Đang khởi động lại",
    restarting: "Đang khởi động lại",
    stopped: "Đã tắt",
    offline: "Đã tắt",
    terminated: "Đã tắt",
    error: "Không thể kết nối",
    unknown: "Không xác định",
    loading: "Đang tải..."
};

function normalizeApiUrl(url) {
    return url.trim().replace(/\/+$/, "");
}

function hasConfiguredApi() {
    return state.apiUrl && state.apiUrl !== DEFAULT_API_URL;
}

async function apiRequest(path, options = {}) {
    if (!hasConfiguredApi()) {
        throw new Error("API Gateway chưa được cấu hình.");
    }

    const response = await fetch(`${state.apiUrl}${path}`, {
        ...options,
        headers: {
            "Content-Type": "application/json",
            ...(state.apiToken ? { "x-control-token": state.apiToken } : {}),
            ...options.headers
        }
    });

    const contentType = response.headers.get("content-type") || "";
    const body = contentType.includes("application/json")
        ? await response.json()
        : await response.text();

    if (!response.ok) {
        const message = typeof body === "object"
            ? body.message || body.error
            : body;
        throw new Error(message || `Yêu cầu thất bại (${response.status}).`);
    }

    return body;
}

function normalizeStatus(value) {
    const normalized = String(value || "unknown").toLowerCase();
    if (["running", "online", "started"].includes(normalized)) return "running";
    if (["stopped", "offline", "terminated"].includes(normalized)) return "stopped";
    if (["pending", "starting"].includes(normalized)) return "pending";
    if (["stopping"].includes(normalized)) return "stopping";
    if (["rebooting", "restarting"].includes(normalized)) return "rebooting";
    return normalized;
}

function pick(data, keys, fallback = null) {
    for (const key of keys) {
        if (data?.[key] !== undefined && data[key] !== null && data[key] !== "") {
            return data[key];
        }
    }
    return fallback;
}

function formatUptime(value) {
    if (value === null || value === undefined || value === "") return "--";
    if (typeof value === "string" && !/^\d+$/.test(value)) return value;

    let seconds = Number(value);
    if (!Number.isFinite(seconds)) return "--";
    if (seconds > 100000000000) seconds = (Date.now() - seconds) / 1000;
    if (seconds > 1000000000) seconds = Date.now() / 1000 - seconds;
    seconds = Math.max(0, seconds);

    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);

    if (days) return `${days} ngày ${hours} giờ`;
    if (hours) return `${hours} giờ ${minutes} phút`;
    return `${minutes} phút`;
}

function updateConnection(type, text) {
    elements.connectionPill.classList.remove("is-connected", "is-error");
    if (type) elements.connectionPill.classList.add(type);
    elements.connectionText.textContent = text;
}

function renderStatus(status) {
    state.status = normalizeStatus(status);
    const visualState = state.status === "running"
        ? "online"
        : state.status === "stopped"
            ? "offline"
            : ["pending", "stopping", "rebooting", "loading"].includes(state.status)
                ? "loading"
                : "error";

    elements.serverStatus.textContent = statusLabels[state.status] || statusLabels.unknown;
    elements.statusOrb.className = `status-orb is-${visualState}`;

    const online = state.status === "running";
    const offline = state.status === "stopped";
    elements.startButton.disabled = !offline;
    elements.stopButton.disabled = !online;
    elements.restartInstanceButton.disabled = !online;
    elements.restartServerButton.disabled = !online;
}

function renderServerData(data) {
    const address = pick(data, ["address", "serverAddress", "ip", "publicIp", "public_ip"], "Chưa có dữ liệu");
    const port = pick(data, ["port", "serverPort"]);
    const players = pick(data, ["players", "onlinePlayers", "playerCount"], "--");
    const maxPlayers = pick(data, ["maxPlayers", "max_players", "playerLimit"], "--");
    const version = pick(data, ["version", "serverVersion", "minecraftVersion"], "--");
    const uptime = pick(data, ["uptime", "uptimeSeconds", "startedAt", "startTime"]);

    elements.serverAddress.textContent = port && !String(address).includes(":")
        ? `${address}:${port}`
        : address;
    elements.playerCount.textContent = typeof players === "object"
        ? `${players.online ?? "--"} / ${players.max ?? maxPlayers}`
        : `${players} / ${maxPlayers}`;
    elements.serverVersion.textContent = version;
    elements.uptime.textContent = formatUptime(uptime);
}

function readStatusCache() {
    try {
        const cached = JSON.parse(localStorage.getItem(STATUS_CACHE_KEY));
        if (!cached?.data || !cached?.savedAt) return null;
        return {
            ...cached,
            fresh: Date.now() - cached.savedAt < STATUS_CACHE_TTL
        };
    } catch {
        localStorage.removeItem(STATUS_CACHE_KEY);
        return null;
    }
}

function writeStatusCache(data) {
    localStorage.setItem(STATUS_CACHE_KEY, JSON.stringify({
        data,
        savedAt: Date.now()
    }));
}

function clearStatusCache() {
    localStorage.removeItem(STATUS_CACHE_KEY);
}

function applyStatusData(data, savedAt = Date.now(), fromCache = false) {
    renderStatus(pick(data, ["status", "state", "instanceState"], "unknown"));
    renderServerData(data);
    elements.lastUpdate.textContent = new Date(savedAt).toLocaleTimeString("vi-VN");
    updateConnection("is-connected", fromCache ? "Đang dùng cache" : "Lambda đã kết nối");
}

async function updateStatus({ silent = false, force = false } = {}) {
    if (state.isRefreshing) return;

    const cached = readStatusCache();
    if (!force && cached?.fresh) {
        applyStatusData(cached.data, cached.savedAt, true);
        return;
    }

    state.isRefreshing = true;
    elements.refreshButton.classList.add("is-spinning");

    if (!silent) {
        updateConnection("", "Đang kết nối");
    }

    try {
        const data = await apiRequest("/status");
        writeStatusCache(data);
        applyStatusData(data);
    } catch (error) {
        console.error(error);
        if (cached?.data) {
            applyStatusData(cached.data, cached.savedAt, true);
            updateConnection("is-error", "Cache cũ - mất kết nối");
        } else {
            renderStatus("error");
            updateConnection("is-error", hasConfiguredApi() ? "Mất kết nối" : "Chưa cấu hình API");
        }
        if (!silent) showToast(error.message, "error");
    } finally {
        state.isRefreshing = false;
        elements.refreshButton.classList.remove("is-spinning");
    }
}

function actionConfig(action) {
    return {
        start: {
            title: "Bật máy chủ?",
            message: "Lambda sẽ khởi chạy instance và Minecraft server. Quá trình này có thể mất vài phút.",
            endpoint: "/start",
            pendingStatus: "pending",
            success: "Đã gửi yêu cầu bật máy chủ.",
            activity: "Yêu cầu bật máy chủ"
        },
        stop: {
            title: "Tắt máy chủ?",
            message: "Người chơi đang online có thể bị ngắt kết nối. Hãy chắc chắn thế giới đã được lưu.",
            endpoint: "/stop",
            pendingStatus: "stopping",
            success: "Đã gửi yêu cầu tắt máy chủ.",
            activity: "Yêu cầu tắt máy chủ"
        },
        restartInstance: {
            title: "Restart toàn bộ EC2?",
            message: "Hệ điều hành và Minecraft server đều sẽ khởi động lại. Người chơi sẽ mất kết nối trong vài phút.",
            endpoint: "/restart-instance",
            pendingStatus: "rebooting",
            success: "Đã gửi yêu cầu restart EC2.",
            activity: "Yêu cầu restart EC2"
        },
        restartServer: {
            title: "Chỉ restart Minecraft?",
            message: "Lambda sẽ dùng SSM để restart service Minecraft mà không restart EC2.",
            endpoint: "/restart-server",
            pendingStatus: "rebooting",
            success: "Đã gửi lệnh restart Minecraft.",
            activity: "Yêu cầu restart Minecraft"
        }
    }[action];
}

function openConfirmation(action) {
    const config = actionConfig(action);
    state.pendingAction = action;
    elements.confirmTitle.textContent = config.title;
    elements.confirmMessage.textContent = config.message;
    elements.confirmAction.textContent = action === "start"
        ? "Bật server"
        : action === "stop"
            ? "Tắt server"
            : action === "restartInstance"
                ? "Restart EC2"
                : "Restart Minecraft";
    elements.confirmAction.style.background = action === "stop"
        ? "var(--red)"
        : action === "restartInstance"
            ? "var(--orange)"
            : action === "restartServer"
                ? "#72b7ff"
                : "var(--green)";
    elements.confirmModal.hidden = false;
    elements.confirmAction.focus();
}

function closeConfirmation() {
    elements.confirmModal.hidden = true;
    state.pendingAction = null;
}

async function executeAction() {
    const action = state.pendingAction;
    const config = actionConfig(action);
    if (!config) return;

    closeConfirmation();
    setControlsBusy(true);
    renderStatus(config.pendingStatus);

    try {
        await apiRequest(config.endpoint, { method: "POST" });
        clearStatusCache();
        addActivity(config.activity);
        showToast(config.success);
        window.setTimeout(() => updateStatus({ silent: true, force: true }), 1500);
    } catch (error) {
        console.error(error);
        addActivity(`${config.activity} thất bại`, true);
        showToast(error.message, "error");
        await updateStatus({ silent: true, force: true });
    } finally {
        setControlsBusy(false);
    }
}

function setControlsBusy(isBusy) {
    [
        elements.startButton,
        elements.stopButton,
        elements.restartInstanceButton,
        elements.restartServerButton
    ].forEach((button) => {
        button.classList.toggle("is-busy", isBusy);
    });
    elements.confirmAction.disabled = isBusy;
}

function addActivity(message, isError = false) {
    state.activities.unshift({
        message,
        isError,
        time: new Date()
    });
    state.activities = state.activities.slice(0, 6);
    renderActivities();
}

function renderActivities() {
    if (!state.activities.length) {
        elements.activityList.innerHTML = '<div class="empty-activity">Chưa có thao tác nào trong phiên này.</div>';
        return;
    }

    elements.activityList.innerHTML = state.activities.map((item) => `
        <div class="activity-item${item.isError ? " is-error" : ""}">
            <span class="activity-dot"></span>
            <strong>${escapeHtml(item.message)}</strong>
            <time>${item.time.toLocaleTimeString("vi-VN")}</time>
        </div>
    `).join("");
}

function escapeHtml(value) {
    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

function showToast(message, type = "success") {
    const toast = document.createElement("div");
    toast.className = `toast${type === "error" ? " is-error" : ""}`;
    toast.textContent = message;
    elements.toastRegion.appendChild(toast);
    window.setTimeout(() => toast.remove(), 4200);
}

async function copyAddress() {
    const address = elements.serverAddress.textContent;
    if (!address || address === "Chưa có dữ liệu") {
        showToast("Chưa có địa chỉ server để sao chép.", "error");
        return;
    }

    try {
        await navigator.clipboard.writeText(address);
        showToast("Đã sao chép địa chỉ server.");
    } catch {
        showToast("Trình duyệt không cho phép truy cập clipboard.", "error");
    }
}

function openSettings() {
    elements.apiUrlInput.value = hasConfiguredApi() ? state.apiUrl : "";
    elements.apiTokenInput.value = state.apiToken;
    elements.settingsModal.hidden = false;
    elements.apiUrlInput.focus();
}

function closeSettings() {
    elements.settingsModal.hidden = true;
}

function saveSettings() {
    const value = normalizeApiUrl(elements.apiUrlInput.value);
    if (!value || !/^https?:\/\//i.test(value)) {
        showToast("Hãy nhập API Gateway URL hợp lệ.", "error");
        return;
    }

    state.apiUrl = value;
    state.apiToken = elements.apiTokenInput.value.trim();
    localStorage.setItem("blockops_api_url", value);
    if (state.apiToken) {
        localStorage.setItem("blockops_api_token", state.apiToken);
    } else {
        localStorage.removeItem("blockops_api_token");
    }
    clearStatusCache();
    closeSettings();
    showToast("Đã lưu cấu hình API Gateway.");
    updateStatus({ force: true });
}

function resetSettings() {
    localStorage.removeItem("blockops_api_url");
    localStorage.removeItem("blockops_api_token");
    clearStatusCache();
    state.apiUrl = DEFAULT_API_URL;
    state.apiToken = "";
    elements.apiUrlInput.value = "";
    elements.apiTokenInput.value = "";
    closeSettings();
    renderStatus("error");
    updateConnection("is-error", "Chưa cấu hình API");
    showToast("Đã xóa cấu hình API.", "error");
}

elements.refreshButton.addEventListener("click", () => updateStatus({ force: true }));
elements.startButton.addEventListener("click", () => openConfirmation("start"));
elements.stopButton.addEventListener("click", () => openConfirmation("stop"));
elements.restartInstanceButton.addEventListener("click", () => openConfirmation("restartInstance"));
elements.restartServerButton.addEventListener("click", () => openConfirmation("restartServer"));
elements.confirmAction.addEventListener("click", executeAction);
elements.cancelAction.addEventListener("click", closeConfirmation);
elements.copyButton.addEventListener("click", copyAddress);
elements.clearLogButton.addEventListener("click", () => {
    state.activities = [];
    renderActivities();
});
elements.settingsButton.addEventListener("click", openSettings);
elements.closeSettings.addEventListener("click", closeSettings);
elements.saveApiUrl.addEventListener("click", saveSettings);
elements.resetApiUrl.addEventListener("click", resetSettings);

[elements.confirmModal, elements.settingsModal].forEach((modal) => {
    modal.addEventListener("click", (event) => {
        if (event.target !== modal) return;
        modal === elements.confirmModal ? closeConfirmation() : closeSettings();
    });
});

document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (!elements.confirmModal.hidden) closeConfirmation();
    if (!elements.settingsModal.hidden) closeSettings();
});

renderStatus("loading");
updateStatus();
window.setInterval(() => updateStatus({ silent: true }), REFRESH_INTERVAL);
