// ==UserScript==
// @name         qBittorrent Torrent Interceptor
// @namespace    https://github.com/joshkerr/qbit-tampermonkey
// @version      1.13.0
// @description  Intercept torrent downloads and magnet links, send them to qBittorrent, follow TV shows with qbt-dl, or download locally
// @author       joshkerr
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_notification
// @grant        GM_addStyle
// @grant        GM_openInTab
// @grant        GM_cookie
// @connect      *
// @run-at       document-start
// @noframes
// ==/UserScript==

(function() {
    'use strict';

    // ============================================
    // CONFIGURATION - Edit these values
    // ============================================
    // Getters read live from GM storage so settings changed in another tab
    // (or in this tab's settings modal) apply without a page reload.
    const CONFIG = {
        // qBittorrent Web UI settings
        qbittorrent: {
            get url() { return GM_getValue('qbit_url', 'http://localhost:8080'); },
            get username() { return GM_getValue('qbit_username', 'admin'); },
            get password() { return GM_getValue('qbit_password', 'adminadmin'); },
        },
        // Optional qbt-dl daemon. Its token is independent of qBittorrent login.
        daemon: {
            get enabled() { return GM_getValue('qbit_daemon_enabled', false); },
            get url() { return GM_getValue('qbit_daemon_url', 'http://localhost:8791'); },
            get token() { return GM_getValue('qbit_daemon_token', ''); },
            get destination() { return GM_getValue('qbit_daemon_destination', ''); },
        },
        // Default save path (leave empty for qBittorrent default)
        get savePath() { return GM_getValue('qbit_savepath', ''); },
        // Category for added torrents (leave empty for none)
        get category() { return GM_getValue('qbit_category', ''); },
        // Automatically start torrent after adding
        get autoStart() { return GM_getValue('qbit_autostart', true); },
        // Use Automatic Torrent Management (lets qBittorrent manage save paths by category)
        get autoTMM() { return GM_getValue('qbit_autotmm', true); },
        // Show notifications
        get showNotifications() { return GM_getValue('qbit_notifications', true); },
        // Show confirmation dialog before adding
        get showConfirmation() { return GM_getValue('qbit_confirmation', true); },
    };

    // Timeout for all network requests (GM_xmlhttpRequest and fetch)
    const REQUEST_TIMEOUT_MS = 15000;

    // Verbose console logging (toggle in the settings modal)
    let debugMode = GM_getValue('qbit_debug', false);
    function debugLog(...args) {
        if (debugMode) console.log(...args);
    }

    // Session ID for qBittorrent authentication
    let qbitSessionId = null;

    // ============================================
    // STYLES
    // ============================================
    GM_addStyle(`
        .qbit-modal-overlay {
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.7);
            z-index: 999999;
            display: flex;
            align-items: center;
            justify-content: center;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
        }
        .qbit-modal {
            background: #fff;
            border-radius: 12px;
            padding: 24px;
            max-width: 500px;
            box-sizing: border-box;
            max-height: 90vh;
            overflow-y: auto;
            width: 90%;
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
            color: #000;
        }
        .qbit-modal-dark {
            background: #1e1e1e;
            color: #fff;
        }
        .qbit-modal h2 {
            margin: 0 0 16px 0;
            font-size: 18px;
            font-weight: 600;
        }
        .qbit-modal-content {
            margin-bottom: 20px;
        }
        .qbit-modal label {
            display: block;
            margin-bottom: 12px;
            font-size: 14px;
        }
        .qbit-modal input[type="text"],
        .qbit-modal input[type="password"],
        .qbit-modal input[type="number"],
        .qbit-modal select {
            width: 100%;
            padding: 10px 12px;
            border: 1px solid #ccc;
            border-radius: 6px;
            font-size: 14px;
            box-sizing: border-box;
            margin-top: 4px;
        }
        .qbit-modal-dark input[type="text"],
        .qbit-modal-dark input[type="password"],
        .qbit-modal-dark input[type="number"],
        .qbit-modal-dark select {
            background: #2d2d2d;
            border-color: #444;
            color: #fff;
        }
        .qbit-modal-buttons {
            display: flex;
            justify-content: flex-end;
            flex-wrap: wrap;
            gap: 10px;
        }
        .qbit-modal button {
            padding: 10px 20px;
            border: none;
            border-radius: 6px;
            font-size: 14px;
            cursor: pointer;
            font-weight: 500;
        }
        .qbit-modal button:disabled { opacity: 0.5; cursor: wait; }
        .qbit-show-from:not([hidden]) { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
        .qbit-status { font-size: 13px; white-space: pre-line; overflow-wrap: anywhere; }
        .qbit-btn-primary {
            background: #2196F3;
            color: white;
        }
        .qbit-btn-primary:hover {
            background: #1976D2;
        }
        .qbit-btn-secondary {
            background: #e0e0e0;
            color: #333;
        }
        .qbit-btn-secondary:hover {
            background: #d0d0d0;
        }
        .qbit-modal-dark .qbit-btn-secondary {
            background: #444;
            color: #fff;
        }
        .qbit-toast {
            position: fixed;
            bottom: 20px;
            right: 20px;
            padding: 14px 20px;
            border-radius: 8px;
            color: white;
            font-size: 14px;
            z-index: 999999;
            animation: qbit-slide-in 0.3s ease;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            max-width: 350px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
        }
        .qbit-toast-success {
            background: #4CAF50;
        }
        .qbit-toast-error {
            background: #f44336;
        }
        .qbit-toast-info {
            background: #2196F3;
        }
        @keyframes qbit-slide-in {
            from {
                transform: translateX(100%);
                opacity: 0;
            }
            to {
                transform: translateX(0);
                opacity: 1;
            }
        }
        .qbit-torrent-name {
            font-weight: 500;
            word-break: break-all;
            background: rgba(0,0,0,0.1);
            padding: 8px 10px;
            border-radius: 6px;
            margin: 10px 0;
            font-size: 13px;
        }
        .qbit-actions-divider {
            border: none;
            border-top: 1px solid #ddd;
            margin: 16px 0 12px;
        }
        .qbit-modal-dark .qbit-actions-divider {
            border-top-color: #444;
        }
        .qbit-actions-header {
            font-size: 13px;
            font-weight: 600;
            color: #888;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            margin-bottom: 10px;
        }
        .qbit-actions-grid {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
            margin-bottom: 12px;
        }
        .qbit-action-btn {
            padding: 8px 14px;
            border: 1px solid #ccc;
            border-radius: 6px;
            font-size: 13px;
            cursor: pointer;
            background: #f5f5f5;
            color: #333;
            font-weight: 500;
        }
        .qbit-action-btn:hover {
            background: #e8e8e8;
        }
        .qbit-modal-dark .qbit-action-btn {
            background: #2d2d2d;
            border-color: #555;
            color: #ddd;
        }
        .qbit-modal-dark .qbit-action-btn:hover {
            background: #3a3a3a;
        }
        .qbit-toggle-row {
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 13px;
            margin-top: 4px;
        }
        .qbit-toggle-row input[type="checkbox"] {
            width: 16px;
            height: 16px;
            cursor: pointer;
        }
        .qbit-toggle-label {
            cursor: pointer;
            user-select: none;
        }
        .qbit-toggle-hint {
            font-size: 11px;
            color: #999;
            margin-top: 2px;
        }
        .qbit-modal-dark .qbit-actions-header {
            color: #aaa;
        }
        .qbit-modal-dark .qbit-toggle-hint {
            color: #777;
        }
    `);

    // ============================================
    // UTILITY FUNCTIONS
    // ============================================

    // Escape untrusted text (torrent names, stored settings) before inserting
    // into innerHTML or HTML attributes
    function escapeHtml(str) {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // decodeURIComponent throws URIError on malformed percent-encoding
    function safeDecodeURIComponent(str) {
        try {
            return decodeURIComponent(str);
        } catch (e) {
            return str;
        }
    }

    function showToast(message, type = 'info') {
        if (!CONFIG.showNotifications) return;

        // Before <body> exists (document-start), fall back to a GM notification
        if (!document.body) {
            if (typeof GM_notification === 'function') {
                GM_notification({ text: message, title: 'qBittorrent', timeout: 4000 });
            }
            return;
        }

        const toast = document.createElement('div');
        toast.className = `qbit-toast qbit-toast-${type}`;
        toast.textContent = message;
        // Stack above any toasts already showing instead of overlapping them
        const existing = document.querySelectorAll('.qbit-toast').length;
        toast.style.bottom = `${20 + existing * 60}px`;
        document.body.appendChild(toast);

        setTimeout(() => {
            toast.style.animation = 'qbit-slide-in 0.3s ease reverse';
            setTimeout(() => toast.remove(), 300);
        }, 4000);
    }

    function isDarkMode() {
        return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    }

    // options.confirmLabel: text for the primary button (default "Add to qBittorrent")
    // options.keepOpenOnConfirm / canClose: keep async forms open until they finish.
    // options.extraButtons: array of { label, className, onClick } shown between Cancel and Confirm.
    //   Each extra button closes the modal before invoking onClick.
    function showModal(title, content, onConfirm, onCancel, options = {}) {
        const overlay = document.createElement('div');
        overlay.className = 'qbit-modal-overlay';

        const modal = document.createElement('div');
        modal.className = `qbit-modal ${isDarkMode() ? 'qbit-modal-dark' : ''}`;

        const confirmLabel = options.confirmLabel || 'Add to qBittorrent';
        const extraButtons = options.extraButtons || [];

        // Buttons are looked up via modal.querySelector (not global IDs) so
        // two modals can coexist without their handlers cross-wiring
        modal.innerHTML = `
            <h2>${escapeHtml(title)}</h2>
            <div class="qbit-modal-content">${content}</div>
            <div class="qbit-modal-buttons">
                <button class="qbit-btn-secondary qbit-cancel">Cancel</button>
                <button class="qbit-btn-primary qbit-confirm"></button>
            </div>
        `;

        const buttonRow = modal.querySelector('.qbit-modal-buttons');
        const confirmBtn = modal.querySelector('.qbit-confirm');
        confirmBtn.textContent = confirmLabel;

        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        const close = () => {
            if (options.canClose && !options.canClose()) return false;
            document.removeEventListener('keydown', onKeydown, true);
            overlay.remove();
            return true;
        };
        const cancel = () => {
            if (!close()) return;
            if (onCancel) onCancel();
        };
        const onKeydown = (e) => {
            if (e.key === 'Escape') {
                e.stopPropagation();
                cancel();
            }
        };
        document.addEventListener('keydown', onKeydown, true);

        confirmBtn.onclick = () => {
            if (!options.keepOpenOnConfirm) close();
            if (onConfirm) onConfirm();
        };

        modal.querySelector('.qbit-cancel').onclick = cancel;

        extraButtons.forEach((btn) => {
            const el = document.createElement('button');
            el.className = btn.className || 'qbit-btn-secondary';
            el.textContent = btn.label;
            el.onclick = () => {
                close();
                if (btn.onClick) btn.onClick();
            };
            buttonRow.insertBefore(el, confirmBtn);
        });

        overlay.onclick = (e) => {
            if (e.target === overlay) cancel();
        };

        return { close, modal };
    }

    function showConfigModal() {
        const overlay = document.createElement('div');
        overlay.className = 'qbit-modal-overlay';

        const modal = document.createElement('div');
        modal.className = `qbit-modal ${isDarkMode() ? 'qbit-modal-dark' : ''}`;

        modal.innerHTML = `
            <h2>⚙️ qBittorrent Settings</h2>
            <div class="qbit-modal-content">
                <label>
                    qBittorrent URL:
                    <input type="text" id="qbit-cfg-url" value="${escapeHtml(CONFIG.qbittorrent.url)}" placeholder="http://localhost:8080">
                </label>
                <label>
                    Username:
                    <input type="text" id="qbit-cfg-username" value="${escapeHtml(CONFIG.qbittorrent.username)}">
                </label>
                <label>
                    Password:
                    <input type="password" id="qbit-cfg-password" value="${escapeHtml(CONFIG.qbittorrent.password)}">
                </label>
                <label>
                    Default Save Path (optional):
                    <input type="text" id="qbit-cfg-savepath" value="${escapeHtml(CONFIG.savePath)}" placeholder="/downloads/torrents">
                </label>
                <label>
                    Category (optional):
                    <input type="text" id="qbit-cfg-category" value="${escapeHtml(CONFIG.category)}">
                </label>
                <hr class="qbit-actions-divider">
                <div class="qbit-actions-header">qbt-dl TV subscriptions</div>
                <label><input type="checkbox" id="qbit-cfg-daemon-enabled" ${CONFIG.daemon.enabled ? 'checked' : ''}> Offer to follow TV shows</label>
                <label>Daemon URL:
                    <input type="text" id="qbit-cfg-daemon-url" value="${escapeHtml(CONFIG.daemon.url)}" placeholder="http://mediaserver:8791">
                </label>
                <label>Daemon token:
                    <input type="password" id="qbit-cfg-daemon-token" value="${escapeHtml(CONFIG.daemon.token)}" autocomplete="off">
                </label>
                <label>Default destination on daemon:
                    <select id="qbit-cfg-daemon-destination"></select>
                </label>
                <button class="qbit-action-btn" id="qbit-act-daemon-test">Test daemon &amp; load destinations</button>
                <p class="qbit-status" id="qbit-daemon-status" role="status">Use the URL and token printed by qbt-dl daemon. Configure its catalog, sources and destinations first.</p>
                <hr class="qbit-actions-divider">
                <div class="qbit-actions-header">Quick Actions</div>
                <div class="qbit-actions-grid">
                    <button class="qbit-action-btn" id="qbit-act-relogin">🔄 Force Re-login</button>
                    <button class="qbit-action-btn" id="qbit-act-webui">📊 Open Web UI</button>
                    <button class="qbit-action-btn" id="qbit-act-session">🔑 Sign in via Web UI</button>
                </div>
                <div class="qbit-toggle-row">
                    <input type="checkbox" id="qbit-act-fetch" ${forceFetchMode ? 'checked' : ''}>
                    <label class="qbit-toggle-label" for="qbit-act-fetch">Fetch Mode (currently ${forceFetchMode ? 'ON' : 'OFF'})</label>
                </div>
                <div class="qbit-toggle-hint">Uses browser fetch API instead of GM_xmlhttpRequest. Requires CORS. Reload page after changing.</div>
                <div class="qbit-toggle-row">
                    <input type="checkbox" id="qbit-act-debug" ${debugMode ? 'checked' : ''}>
                    <label class="qbit-toggle-label" for="qbit-act-debug">Debug Logging (currently ${debugMode ? 'ON' : 'OFF'})</label>
                </div>
                <div class="qbit-toggle-hint">Logs API activity to the browser console.</div>
            </div>
            <div class="qbit-modal-buttons">
                <button class="qbit-btn-secondary" id="qbit-cfg-cancel">Cancel</button>
                <button class="qbit-btn-primary" id="qbit-cfg-save">Save Settings</button>
            </div>
        `;

        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        const daemonDestination = modal.querySelector('#qbit-cfg-daemon-destination');
        daemonDestination.add(new Option(CONFIG.daemon.destination || 'Choose when following', CONFIG.daemon.destination));
        let destinationConnection = JSON.stringify([CONFIG.daemon.url, CONFIG.daemon.token]);
        const daemonSettings = () => ({
            url: modal.querySelector('#qbit-cfg-daemon-url').value.trim(),
            token: modal.querySelector('#qbit-cfg-daemon-token').value.trim(),
        });
        modal.querySelector('#qbit-act-daemon-test').onclick = async (event) => {
            const button = event.currentTarget;
            const status = modal.querySelector('#qbit-daemon-status');
            button.disabled = true;
            status.textContent = 'Connecting…';
            const settings = daemonSettings();
            try {
                const state = await loadDaemonState(settings);
                if (JSON.stringify(daemonSettings()) !== JSON.stringify(settings)) {
                    status.textContent = 'Settings changed. Test the connection again.';
                    return;
                }
                daemonDestination.replaceChildren(new Option('Choose when following', ''));
                state.destinations.forEach(path => daemonDestination.add(new Option(path, path)));
                if (state.destinations.includes(CONFIG.daemon.destination)) daemonDestination.value = CONFIG.daemon.destination;
                destinationConnection = JSON.stringify([settings.url, settings.token]);
                status.textContent = `Connected. ${state.destinations.length} destination(s). ${daemonReadiness(state)}`;
            } catch (error) {
                status.textContent = error.message;
            } finally {
                button.disabled = false;
            }
        };

        // Quick action: Force Re-login
        modal.querySelector('#qbit-act-relogin').onclick = async () => {
            qbitSessionId = null;
            GM_setValue('qbit_session', null);
            // Give the silent cookie path another chance (permissions may have changed)
            setCookieApiBroken(false);
            closeConfig();
            showToast('Session cleared, logging in...', 'info');
            // On Safari this verifies the session actually stuck (and falls
            // back to the Web UI tab sign-in if it didn't)
            const success = isSafari ? await ensureAuthenticatedSafari() : await qbitLogin();
            if (success) {
                showToast('Re-login successful!', 'success');
            }
        };

        // Quick action: Open Web UI (keep modal open so user can continue configuring)
        modal.querySelector('#qbit-act-webui').onclick = () => {
            window.open(CONFIG.qbittorrent.url, '_blank', 'noopener,noreferrer');
        };

        // Quick action: Sign in via Web UI tab (Safari/iOS/iPadOS cookie session).
        // Called straight from the click so window.open keeps the user gesture.
        modal.querySelector('#qbit-act-session').onclick = () => {
            closeConfig();
            autoLoginViaTab();
        };

        // Quick action: Toggle Fetch Mode
        const fetchCheckbox = modal.querySelector('#qbit-act-fetch');
        const fetchLabel = modal.querySelector('label[for="qbit-act-fetch"]');
        fetchCheckbox.onchange = () => {
            forceFetchMode = fetchCheckbox.checked;
            GM_setValue('qbit_force_fetch', forceFetchMode);
            fetchLabel.textContent = `Fetch Mode (currently ${forceFetchMode ? 'ON' : 'OFF'})`;
            showToast(`Fetch mode: ${forceFetchMode ? 'ON (uses CORS)' : 'OFF (uses GM_xmlhttpRequest)'}. Reload page to apply.`, 'info');
        };

        // Quick action: Toggle Debug Logging
        const debugCheckbox = modal.querySelector('#qbit-act-debug');
        const debugLabel = modal.querySelector('label[for="qbit-act-debug"]');
        debugCheckbox.onchange = () => {
            debugMode = debugCheckbox.checked;
            GM_setValue('qbit_debug', debugMode);
            debugLabel.textContent = `Debug Logging (currently ${debugMode ? 'ON' : 'OFF'})`;
        };

        modal.querySelector('#qbit-cfg-save').onclick = () => {
            const url = modal.querySelector('#qbit-cfg-url').value.trim().replace(/\/$/, '');
            const username = modal.querySelector('#qbit-cfg-username').value;
            const password = modal.querySelector('#qbit-cfg-password').value;
            const savePath = modal.querySelector('#qbit-cfg-savepath').value;
            const category = modal.querySelector('#qbit-cfg-category').value;

            const daemon = daemonSettings();
            const daemonEnabled = modal.querySelector('#qbit-cfg-daemon-enabled').checked;
            if (daemonEnabled) {
                try { validateDaemonSettings(daemon); }
                catch (error) {
                    modal.querySelector('#qbit-daemon-status').textContent = error.message;
                    return;
                }
            }
            GM_setValue('qbit_daemon_enabled', daemonEnabled);
            GM_setValue('qbit_daemon_url', daemon.url);
            GM_setValue('qbit_daemon_token', daemon.token);
            GM_setValue('qbit_daemon_destination', destinationConnection === JSON.stringify([daemon.url, daemon.token]) ? daemonDestination.value : '');

            GM_setValue('qbit_url', url);
            GM_setValue('qbit_username', username);
            GM_setValue('qbit_password', password);
            GM_setValue('qbit_savepath', savePath);
            GM_setValue('qbit_category', category);

            // CONFIG reads live from GM storage, so no local copies to update.
            // Reset session to force re-auth
            qbitSessionId = null;

            closeConfig();
            showToast('Settings saved!', 'success');
        };

        const closeConfig = () => {
            document.removeEventListener('keydown', onConfigKeydown, true);
            overlay.remove();
        };
        const onConfigKeydown = (e) => {
            if (e.key === 'Escape') {
                e.stopPropagation();
                closeConfig();
            }
        };
        document.addEventListener('keydown', onConfigKeydown, true);

        modal.querySelector('#qbit-cfg-cancel').onclick = closeConfig;

        overlay.onclick = (e) => {
            if (e.target === overlay) closeConfig();
        };
    }

    // ============================================
    // QBT-DL DAEMON / TV SUBSCRIPTIONS
    // ============================================

    function validateDaemonSettings(settings) {
        let url;
        try { url = new URL(settings.url); } catch (_) { /* handled below */ }
        if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
            throw new Error('Enter an HTTP(S) daemon URL without credentials, query or fragment.');
        }
        if (!settings.token.trim() || /[\r\n]/.test(settings.token)) {
            throw new Error('Enter the bearer token printed by qbt-dl daemon.');
        }
        return url.href.replace(/\/+$/, '');
    }

    function daemonRequest(command, settings) {
        return new Promise((resolve, reject) => {
            const base = validateDaemonSettings(settings);
            // Always use the userscript transport: no page CORS changes or qBittorrent cookies.
            // Explicit timeout also covers managers whose fetch transport ignores timeout.
            let request;
            const timer = setTimeout(() => {
                reject(new Error('qbt-dl request timed out. Check the daemon URL and network.'));
                if (request && request.abort) request.abort();
            }, REQUEST_TIMEOUT_MS);
            const fail = message => { clearTimeout(timer); reject(new Error(message)); };
            try {
                request = GM_xmlhttpRequest({
                    method: command ? 'POST' : 'GET',
                    url: `${base}/api/v1/library`,
                    headers: { Authorization: `Bearer ${settings.token.trim()}`, 'Content-Type': 'application/json', Accept: 'application/json' },
                    data: command ? JSON.stringify(command) : undefined,
                    anonymous: true,
                    redirect: 'error',
                    timeout: REQUEST_TIMEOUT_MS,
                    onload: response => {
                        clearTimeout(timer);
                        if (response.status === 401 || response.status === 403) {
                            return fail('qbt-dl rejected the token. Check the daemon settings.');
                        }
                        if (response.status === 404) return fail('Library API not found. Use qbt-dl 3.4.0 or newer and its daemon base URL.');
                        let result;
                        try { result = JSON.parse(response.responseText); }
                        catch (_) { return fail('qbt-dl returned an invalid response. Check the URL and reverse proxy.'); }
                        if (response.status < 200 || response.status >= 300) {
                            return fail(typeof result?.error === 'string' ? result.error : `qbt-dl returned HTTP ${response.status}.`);
                        }
                        if (!result || typeof result !== 'object' || Array.isArray(result)) return fail('Invalid qbt-dl API response.');
                        resolve(result);
                    },
                    onerror: () => fail('Cannot reach qbt-dl. Check the URL, network and Tampermonkey host permission; use the final URL without redirects.'),
                    ontimeout: () => fail('qbt-dl request timed out. Check the daemon URL and network.'),
                    onabort: () => fail('qbt-dl request was cancelled.'),
                });
            } catch (_) {
                fail('Cannot send the qbt-dl request. Check Tampermonkey host permissions.');
            }
        });
    }

    async function loadDaemonState(settings) {
        const result = await daemonRequest(null, settings);
        if (!result.state || !Array.isArray(result.state.destinations) || !result.state.destinations.every(path => typeof path === 'string')) {
            throw new Error('Invalid library response. Use qbt-dl 3.4.0 or newer.');
        }
        return result.state;
    }

    function daemonReadiness(state) {
        if (!state.destinations.length) return 'Add a destination on the daemon before following a show.';
        if (!(state.sources || []).some(source => source.enabled)) return 'No enabled sources. Add an RSS/Torznab source on this daemon to acquire episodes.';
        return 'The daemon will monitor its configured sources.';
    }

    // A hint only: users always select a catalog identity before subscribing.
    function parseShowHint(name) {
        const text = String(name || '').replace(/_/g, ' ');
        const match = /\bS(\d{1,2})[ .-]?E(\d{1,3})\b|\b(\d{1,2})x(\d{1,3})\b|\b(?:S|Season[ .-]*)(\d{1,2})\b/i.exec(text);
        const prefix = match ? text.slice(0, match.index) : text.replace(/\.torrent$/i, '');
        return {
            query: prefix.replace(/[.]+/g, ' ').replace(/[\s\[\]()_-]+$/g, '').trim(),
            season: match ? Number(match[1] || match[3] || match[5]) : 0,
            episode: match ? Number(match[2] || match[4] || 1) : 1,
        };
    }

    function showFollowModal(name = '', torrentUrl = null) {
        if (!CONFIG.daemon.enabled) {
            showConfigModal();
            return;
        }
        // Keep one connection throughout the flow, even if another tab changes settings.
        const settings = { url: CONFIG.daemon.url, token: CONFIG.daemon.token };
        const hint = parseShowHint(name);
        let state = null;
        let titles = [];
        let busy = false;
        let torrentAdded = false;
        let searchGeneration = 0;
        let dialog;
        const content = `
            ${torrentUrl ? `<div class="qbit-torrent-name">${escapeHtml(name)}</div>` : ''}
            <label>Show name:<input type="text" class="qbit-show-query" value="${escapeHtml(hint.query)}"></label>
            <button class="qbit-btn-secondary qbit-show-search">Search shows</button>
            <label>Confirm the show:<select class="qbit-show-title"><option value="">Search and choose a show</option></select></label>
            <p class="qbit-status qbit-show-overview"></p>
            <label>Destination on daemon:<select class="qbit-show-destination"></select></label>
            <label>Episodes to follow:<select class="qbit-show-mode">
                <option value="future">Future episodes only (airing from follow date)</option>
                <option value="missing">All episodes (backfill missing + future)</option>
                <option value="from">From a specific episode (including it)</option>
            </select></label>
            <div class="qbit-show-from" hidden>
                <label>Starting season:<input type="number" min="1" step="1" class="qbit-show-season" value="${hint.season || 1}"></label>
                <label>Starting episode:<input type="number" min="1" step="1" class="qbit-show-episode" value="${hint.episode}"></label>
            </div>
            <p class="qbit-status qbit-show-existing"></p>
            <p class="qbit-status qbit-show-scope-hint"></p>
            <p class="qbit-status">${torrentUrl ? 'This torrent goes to qBittorrent as usual. ' : ''}Following lets the daemon find releases through its configured sources and transfer them to this destination. It does not automatically import the torrent you clicked.</p>
            <p class="qbit-status qbit-show-status" role="status" aria-live="polite">Connecting to daemon…</p>
        `;
        dialog = showModal(torrentUrl ? 'Add torrent & follow TV show' : 'Follow TV show', content, submit, null, {
            confirmLabel: torrentUrl ? 'Add & follow' : 'Follow show',
            keepOpenOnConfirm: true,
            canClose: () => !busy,
        });
        const modal = dialog.modal;
        const find = selector => modal.querySelector(selector);
        const query = find('.qbit-show-query');
        const searchButton = find('.qbit-show-search');
        const titleSelect = find('.qbit-show-title');
        const destination = find('.qbit-show-destination');
        const mode = find('.qbit-show-mode');
        const season = find('.qbit-show-season');
        const episode = find('.qbit-show-episode');
        const status = find('.qbit-show-status');
        const confirm = find('.qbit-confirm');
        const selectedTitle = () => titles.find(title => String(title.id) === titleSelect.value);
        const updateConfirm = () => { confirm.disabled = busy || !state || !selectedTitle() || !destination.value; };
        const updateMode = () => {
            find('.qbit-show-from').hidden = mode.value !== 'from';
            find('.qbit-show-scope-hint').textContent = {
                future: "Episodes airing on or after the subscription's UTC calendar date.",
                missing: 'Fill missing aired episodes across all seasons and keep following new episodes.',
                from: 'Include this episode and later episodes and seasons.',
            }[mode.value];
        };
        mode.onchange = updateMode;
        destination.onchange = updateConfirm;
        titleSelect.onchange = () => {
            const title = selectedTitle();
            const existing = (state?.subscriptions || []).find(sub => sub.title.kind === 'tv' && sub.title.id === title?.id);
            find('.qbit-show-overview').textContent = title?.overview || '';
            find('.qbit-show-existing').textContent = existing
                ? `Already followed${existing.enabled ? '' : ' (paused)'}. Saving updates and enables this subscription; its original follow date is retained.` : '';
            mode.value = existing?.mode || 'future';
            season.value = existing?.fromSeason || hint.season || 1;
            episode.value = existing?.fromEpisode || hint.episode;
            const preferred = existing?.destination || CONFIG.daemon.destination;
            destination.value = state?.destinations.includes(preferred) ? preferred : (state?.destinations[0] || '');
            confirm.textContent = torrentUrl ? 'Add & follow' : existing ? 'Update follow' : 'Follow show';
            if (state) status.textContent = `${title ? 'Ready to save. ' : 'Select the matching show. '}${daemonReadiness(state)}`;
            updateMode();
            updateConfirm();
        };
        query.oninput = () => {
            searchGeneration++;
            titles = [];
            titleSelect.replaceChildren(new Option('Search and choose a show', ''));
            find('.qbit-show-overview').textContent = '';
            find('.qbit-show-existing').textContent = '';
            updateConfirm();
        };
        async function search() {
            const searchText = query.value.trim();
            if (!searchText || busy) return;
            const generation = ++searchGeneration;
            titles = [];
            titleSelect.replaceChildren(new Option('Searching…', ''));
            updateConfirm();
            status.textContent = 'Searching TV catalog…';
            try {
                // Also retries initialization after a transient connection failure.
                if (!state) {
                    const loaded = await loadDaemonState(settings);
                    if (generation !== searchGeneration || !modal.isConnected) return;
                    state = loaded;
                    destination.replaceChildren(...state.destinations.map(path => new Option(path, path)));
                    if (state.destinations.includes(CONFIG.daemon.destination)) destination.value = CONFIG.daemon.destination;
                }
                const result = await daemonRequest({ action: 'discover', query: searchText, kind: 'tv' }, settings);
                if (generation !== searchGeneration || !modal.isConnected) return;
                titles = (result.titles || []).filter(title => title.kind === 'tv' && Number.isInteger(title.id) && title.id > 0 && typeof title.name === 'string');
                titleSelect.replaceChildren(new Option('Choose the matching show', ''), ...titles.map(title => new Option(`${title.name}${title.year ? ` (${title.year})` : ''}`, String(title.id))));
                status.textContent = `${titles.length ? 'Select the matching show.' : 'No shows found. Try another name.'} ${daemonReadiness(state)}`;
            } catch (error) {
                if (generation === searchGeneration && modal.isConnected) status.textContent = error.message;
            } finally {
                updateConfirm();
            }
        }
        searchButton.onclick = search;
        query.onkeydown = event => {
            if (event.key === 'Enter') { event.preventDefault(); search(); }
        };
        async function submit() {
            const title = selectedTitle();
            if (busy || !state || !title || !state.destinations.includes(destination.value)) return;
            const fromSeason = Number(season.value);
            const fromEpisode = Number(episode.value);
            if (mode.value === 'from' && (!Number.isSafeInteger(fromSeason) || !Number.isSafeInteger(fromEpisode) || fromSeason < 1 || fromEpisode < 1)) {
                status.textContent = 'Enter a whole starting season and episode, both at least 1.';
                return;
            }
            const subscription = { title, destination: destination.value, enabled: true, mode: mode.value, fromSeason, fromEpisode };
            busy = true;
            updateConfirm();
            const fields = [...modal.querySelectorAll('input, select, .qbit-show-search, .qbit-cancel')];
            fields.forEach(field => { field.disabled = true; });
            try {
                if (torrentUrl && !torrentAdded) {
                    status.textContent = 'Adding torrent to qBittorrent…';
                    // Keep Safari's login initiation inside this user gesture.
                    if (!await signInFromGestureIfNeeded()) throw new Error('qBittorrent sign-in did not finish. Nothing was followed. Try again.');
                    torrentAdded = isMagnetUrl(torrentUrl)
                        ? await addTorrentByUrl(torrentUrl, name)
                        : await handleTorrentDownload(torrentUrl, extractTorrentName(torrentUrl) + '.torrent');
                    if (!torrentAdded) throw new Error('Torrent was not added. Nothing was followed. Check qBittorrent and try again.');
                }
                status.textContent = 'Saving follow on daemon…';
                await daemonRequest({ action: 'subscribe', subscription }, settings);
                GM_setValue('qbit_daemon_destination', subscription.destination);
                busy = false;
                dialog.close();
                showToast(`Following ${title.name} with qbt-dl`, 'success');
            } catch (error) {
                status.textContent = `${torrentAdded ? 'Torrent added to qBittorrent. Follow could not be confirmed; retry safely without re-adding the torrent. ' : ''}${error.message}`;
                if (torrentAdded) confirm.textContent = 'Retry follow';
            } finally {
                busy = false;
                // After a successful add, keep the selected identity/scope fixed for retries.
                fields.forEach(field => { field.disabled = torrentAdded && !field.matches('.qbit-cancel'); });
                updateConfirm();
            }
        }
        updateMode();
        updateConfirm();
        // Search is explicit for empty titles; no arbitrary catalog match is selected.
        if (query.value.trim()) search();
        else status.textContent = 'Enter a show name and search to load the daemon catalog and destinations.';
    }

    // ============================================
    // QBITTORRENT API
    // ============================================

    // Detect Safari/iPadOS (for informational purposes and special handling)
    // iPadOS in desktop mode reports as Macintosh, so we check multiple signals
    const isSafari = (() => {
        const ua = navigator.userAgent;
        const isIOS = /iPad|iPhone|iPod/.test(ua);
        const isMacSafari = /Macintosh/.test(ua) && /Safari/.test(ua) && !/Chrome/.test(ua);
        const hasTouchScreen = navigator.maxTouchPoints > 1;
        // iPadOS in desktop mode: reports as Mac but has touch screen
        const isIPadOS = isMacSafari && hasTouchScreen;
        return isIOS || isIPadOS || isMacSafari;
    })();

    // Force fetch mode - can be toggled via menu for troubleshooting
    // NOTE: Fetch mode is OFF by default because it's blocked by CORS
    // GM_xmlhttpRequest bypasses CORS restrictions
    let forceFetchMode = GM_getValue('qbit_force_fetch', false);

    // Determine if we should use fetch - now OFF by default (requires explicit opt-in)
    const shouldUseFetch = () => forceFetchMode;

    // ============================================
    // SAFARI / iOS SESSION VIA WEB UI TAB
    // ============================================
    // Safari extensions can't set a Cookie header, so on Safari the SID only
    // reaches qBittorrent if it is in Safari's own cookie jar. On macOS the
    // background login's Set-Cookie lands there; on iOS/iPadOS it does not.
    // Workaround: this script also runs on the qBittorrent Web UI origin, so
    // we open the Web UI in a new tab with a marker in the hash, and the
    // script instance on that page logs in with a same-origin fetch (no CORS,
    // CSRF passes, cookie is stored first-party). Then it closes itself and
    // the original tab resumes.

    const AUTOLOGIN_HASH_RE = /^#qbit-autologin=([A-Za-z0-9]+)(&bg)?$/;
    const AUTOLOGIN_TIMEOUT_MS = 120000;

    // Configured qBittorrent URL without trailing slashes
    function qbitBaseUrl() {
        return CONFIG.qbittorrent.url.replace(/\/+$/, '');
    }

    // ============================================
    // SILENT SESSION VIA THE COOKIE API
    // ============================================
    // Opening a tab is only needed because the SID has to end up in the
    // browser's own cookie jar. GM_cookie writes there directly, so where the
    // userscript manager offers it we can take the SID from the background
    // login and install it without anything appearing on screen.

    const hasCookieApi = () => typeof GM_cookie !== 'undefined' && GM_cookie && typeof GM_cookie.set === 'function';

    // Remembered per device: the manager exposes GM_cookie but refuses the
    // write (missing permission). Cleared by "Force Re-login".
    let cookieApiBroken = GM_getValue('qbit_cookie_api_broken', false);
    function setCookieApiBroken(value) {
        if (cookieApiBroken === value) return;
        cookieApiBroken = value;
        GM_setValue('qbit_cookie_api_broken', value);
    }

    // True when a stale session can be repaired without opening anything
    const silentSignInAvailable = () => hasCookieApi() && !cookieApiBroken;

    // Replicate the attributes qBittorrent sent with its SID; guessing them
    // (SameSite in particular) is what decides whether Safari hands the cookie
    // back on the script's cross-site requests.
    function parseSidAttributes(responseHeaders) {
        const line = String(responseHeaders || '')
            .split(/\r?\n/)
            .find((l) => /^set-cookie:/i.test(l) && /SID=/i.test(l)) || '';
        const attrs = { path: '/', httpOnly: /;\s*httponly/i.test(line), secure: /;\s*secure/i.test(line) };
        const path = line.match(/;\s*path=([^;]+)/i);
        if (path) attrs.path = path[1].trim();
        const sameSite = line.match(/;\s*samesite=([^;]+)/i);
        if (sameSite) {
            const v = sameSite[1].trim().toLowerCase();
            attrs.sameSite = v === 'none' ? 'no_restriction' : v; // 'lax' | 'strict' | 'no_restriction'
        }
        return attrs;
    }

    // GM_cookie.set is callback-based in some managers and promise-based in
    // others, and simply absent in older ones. Resolve false rather than throw.
    function gmCookieSet(details) {
        return new Promise((resolve) => {
            let settled = false;
            const done = (error) => {
                if (settled) return;
                settled = true;
                if (error) debugLog('qBittorrent: GM_cookie.set error:', error);
                resolve(!error);
            };
            const timer = setTimeout(() => done('timeout'), 5000);
            const finish = (error) => { clearTimeout(timer); done(error); };
            try {
                const result = GM_cookie.set(details, finish);
                if (result && typeof result.then === 'function') {
                    result.then(() => finish(null), finish);
                }
            } catch (e) {
                finish(e);
            }
        });
    }

    // Install the SID from the background login into the browser's cookie jar.
    // Resolves true only once the session actually works from this page.
    async function plantSessionCookie(sid, responseHeaders) {
        if (!sid || sid === 'safari-auto' || sid === 'no-sid-cookie') return false;
        if (!silentSignInAvailable()) return false;

        const attrs = parseSidAttributes(responseHeaders);
        const details = {
            url: `${qbitBaseUrl()}/`,
            name: 'SID',
            value: sid,
            path: attrs.path,
            httpOnly: attrs.httpOnly,
            secure: attrs.secure,
        };
        if (attrs.sameSite) details.sameSite = attrs.sameSite;

        if (!await gmCookieSet(details)) {
            // The API itself is unusable here - stop paying for it every sign-in
            setCookieApiBroken(true);
            debugLog('qBittorrent: cookie API refused the write, falling back to the Web UI tab');
            return false;
        }

        const ok = await probeSession();
        debugLog('qBittorrent: planted SID cookie ->', ok ? 'session usable' : 'still not usable');
        return ok;
    }

    // Is this page the qBittorrent Web UI opened by autoLoginViaTab()?
    // Returns { nonce, background } or null.
    function getAutoLoginMarker() {
        const m = location.hash.match(AUTOLOGIN_HASH_RE);
        if (!m) return null;
        if (location.origin !== getOriginFromUrl(CONFIG.qbittorrent.url)) return null;
        return { nonce: m[1], background: !!m[2] };
    }

    // Runs on the qBittorrent Web UI page: log in same-origin, report back, close.
    function runAutoLoginPage(nonce, background = false) {
        const base = qbitBaseUrl();

        const report = (ok, reason = '') => {
            try {
                GM_setValue('qbit_autologin_result', { nonce, ok, reason, ts: Date.now() });
            } catch (e) { /* storage unavailable */ }
            try {
                // Only the nonce and outcome cross origins here — no secrets
                if (window.opener) {
                    window.opener.postMessage({ type: 'qbit-autologin', nonce, ok, reason }, '*');
                }
            } catch (e) { /* opener gone */ }
        };

        const whenBodyReady = (fn) => {
            if (document.body) fn();
            else document.addEventListener('DOMContentLoaded', fn, { once: true });
        };

        const probe = async () => {
            const r = await fetch(`${base}/api/v2/app/version`, { credentials: 'same-origin', cache: 'no-store' });
            return r.status === 200;
        };

        (async () => {
            let ok = false;
            let reason = '';
            try {
                ok = await probe();
                if (!ok) {
                    const body = new URLSearchParams({
                        username: CONFIG.qbittorrent.username,
                        password: CONFIG.qbittorrent.password,
                    });
                    const r = await fetch(`${base}/api/v2/auth/login`, {
                        method: 'POST',
                        credentials: 'same-origin',
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                        body: body.toString(),
                    });
                    const text = await r.text();
                    if (r.status === 200 && text === 'Ok.') {
                        ok = await probe();
                        if (!ok) reason = 'cookie';
                    } else if (r.status === 200) {
                        reason = 'credentials'; // qBittorrent answers "Fails."
                    } else {
                        reason = `http ${r.status}`;
                    }
                }
            } catch (e) {
                console.error('qBittorrent auto sign-in error:', e);
                reason = 'network';
            }

            debugLog('qBittorrent: Web UI auto sign-in', ok ? 'succeeded' : `failed (${reason})`);
            report(ok, reason);

            if (ok) {
                // A background tab wasn't opened by script, so window.close()
                // does nothing here — the tab that asked for the sign-in closes
                // us instead. Only tidy up ourselves if that never happens.
                if (!background) window.close();
                setTimeout(() => location.replace(`${base}/`), background ? 15000 : 500);
            } else {
                // Leave the login page up so the user can sign in by hand;
                // strip the marker so a reload doesn't retry.
                try { history.replaceState(null, '', `${base}/`); } catch (e) { /* ignore */ }
                const hint = reason === 'credentials'
                    ? 'qBittorrent auto sign-in failed: wrong username or password. Log in here, then go back to the previous tab.'
                    : `qBittorrent auto sign-in failed (${reason}). Log in here, then go back to the previous tab.`;
                whenBodyReady(() => showToast(hint, 'error'));
            }
        })();
    }

    // Probe the API with whatever cookies Safari has for the qBittorrent origin
    async function probeSession() {
        try {
            const response = await qbitRequest('/api/v2/app/version', 'GET', null);
            return response.status === 200;
        } catch (e) {
            return false;
        }
    }

    // Remembered per device: the background login "succeeds" but its cookie
    // never becomes usable (iOS/iPadOS). When true, a tap can go straight to
    // the Web UI tab instead of discovering that again after the gesture is gone.
    let safariNeedsTabLogin = GM_getValue('qbit_needs_tab_login', false);
    function setSafariNeedsTabLogin(value) {
        if (safariNeedsTabLogin === value) return;
        safariNeedsTabLogin = value;
        GM_setValue('qbit_needs_tab_login', value);
        debugLog('qBittorrent: needs Web UI tab sign-in =', value);
    }

    // Pre-warm: probe the session while the Add dialog is open so that, if it
    // is stale, the tap on "Add" can open the sign-in tab *inside* the user
    // gesture — Safari's pop-up blocker only allows window.open during one.
    const PREWARM_FRESH_MS = 5 * 60 * 1000;
    let safariProbeOk = null;   // last probe result (true/false) or null
    let safariProbeAt = 0;
    let safariProbePromise = null;

    function prewarmSafariSession() {
        if (!isSafari || shouldUseFetch() || safariProbePromise) return;
        safariProbePromise = probeSession()
            .then((ok) => {
                safariProbeOk = ok;
                safariProbeAt = Date.now();
                debugLog('qBittorrent: pre-warm probe ->', ok ? 'session ok' : 'session stale');
            })
            .finally(() => { safariProbePromise = null; });
    }

    // Call synchronously from a click/tap handler (before any await).
    // Resolves true when it's fine to proceed with the add.
    //
    // Only worth doing when the sign-in has to go through window.open, which
    // is the one path that needs a live user gesture. If the session can be
    // repaired silently, or a tab can be opened in the background, the normal
    // async path handles it without hijacking the tap.
    function signInFromGestureIfNeeded() {
        const stale = safariProbeOk === false && (Date.now() - safariProbeAt) < PREWARM_FRESH_MS;
        if (!isSafari || shouldUseFetch() || !safariNeedsTabLogin || !stale) {
            return Promise.resolve(true);
        }
        if (silentSignInAvailable() || hasOpenInTab()) {
            return Promise.resolve(true);
        }
        safariProbeOk = null;
        debugLog('qBittorrent: session known stale, opening sign-in tab from gesture');
        return autoLoginViaTab(); // window.open runs synchronously, inside the gesture
    }

    // Serialize so concurrent adds share one sign-in tab
    let autoLoginInFlight = null;

    function autoLoginViaTab() {
        if (autoLoginInFlight) return autoLoginInFlight;
        autoLoginInFlight = doAutoLoginViaTab().finally(() => {
            autoLoginInFlight = null;
        });
        return autoLoginInFlight;
    }

    const hasOpenInTab = () => typeof GM_openInTab === 'function';

    // Open the sign-in page, preferring a background tab. GM_openInTab is an
    // extension API, so it is not blocked as a pop-up and does not need a live
    // user gesture; window.open (the fallback) always pulls focus away from
    // whatever the user was doing. Returns a handle, or null if nothing opened.
    function openSignInTab(nonce) {
        const base = `${qbitBaseUrl()}/#qbit-autologin=${nonce}`;

        if (hasOpenInTab()) {
            try {
                const tab = GM_openInTab(`${base}&bg`, { active: false, insert: true, setParent: true });
                if (tab) {
                    return {
                        background: true,
                        isClosed: () => !!tab.closed,
                        close: () => { try { tab.close(); } catch (e) { /* already gone */ } },
                    };
                }
            } catch (e) {
                debugLog('qBittorrent: GM_openInTab unavailable:', e);
            }
        }

        try {
            const win = window.open(base, '_blank');
            if (win) {
                return {
                    background: false,
                    isClosed: () => !!win.closed,
                    close: () => { try { win.close(); } catch (e) { /* already gone */ } },
                };
            }
        } catch (e) { /* pop-up blocked */ }

        return null;
    }

    async function doAutoLoginViaTab() {
        const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
        try { GM_setValue('qbit_autologin_result', null); } catch (e) { /* ignore */ }

        let handle = openSignInTab(nonce);
        if (!handle) {
            // Pop-up blocked (we're past the click's user gesture) — ask for a tap
            const tapped = await new Promise((resolve) => {
                showModal(
                    '🔑 Sign in to qBittorrent',
                    `<p>Safari needs a cookie session for qBittorrent. Tap below to open qBittorrent in a new tab — the script will sign in automatically and come back here.</p>`,
                    () => { handle = openSignInTab(nonce); resolve(true); },
                    () => resolve(false),
                    { confirmLabel: 'Open qBittorrent' }
                );
            });
            if (!tapped) return false;
            if (!handle) {
                showToast('Safari blocked the qBittorrent tab. Allow pop-ups for this site and try again.', 'error');
                return false;
            }
        }

        // Rely on Safari's cookie jar from here on (a stale manual SID would only get in the way)
        qbitSessionId = 'safari-auto';
        GM_setValue('qbit_session', null);

        return waitForTabLogin(handle, nonce);
    }

    // Wait until the qBittorrent session is usable from this tab. Listens for
    // the sign-in tab's signal (postMessage / GM storage / tab closed) and also
    // polls the API directly, so it works even if none of the signals arrive.
    //
    // A background tab is invisible, so nothing is put on screen while it does
    // its work — the blocking modal only appears if it fails or stalls.
    const BACKGROUND_ESCALATE_MS = 10000;

    function waitForTabLogin(handle, nonce) {
        return new Promise((resolve) => {
            let done = false;
            let probing = false;
            let modal = null;
            const background = !!(handle && handle.background);
            const startedAt = Date.now();

            const waitingHtml = `
                <p>Opened qBittorrent in a new tab to sign in. This will continue automatically once the session is ready.</p>
                <p style="color: #888; font-size: 12px;">If nothing happens, log in manually in the qBittorrent tab, come back here, and tap Retry.</p>`;
            const failedHtml = `
                <p>Automatic sign-in failed in the qBittorrent tab (check the username and password in settings).</p>
                <p style="color: #888; font-size: 12px;">You can log in manually in that tab, then come back here and tap Retry.</p>`;
            const stalledHtml = `
                <p>Signing in to qBittorrent in a background tab. This is taking longer than usual.</p>
                <p style="color: #888; font-size: 12px;">Switch to the qBittorrent tab to let it finish, then come back here and tap Retry.</p>`;

            const openModal = (html) => {
                if (modal) modal.close();
                modal = showModal(
                    '🔑 Signing in to qBittorrent…',
                    html,
                    () => { modal = null; check(true); },
                    () => { modal = null; finish(false); },
                    { confirmLabel: 'Retry' }
                );
            };

            const finish = (ok) => {
                if (done) return;
                done = true;
                clearInterval(timer);
                window.removeEventListener('message', onMessage);
                if (modal) { modal.close(); modal = null; }
                // A background tab has no opener of its own to close it
                if (ok && background && handle && !handle.isClosed()) handle.close();
                if (ok) {
                    debugLog('qBittorrent: Session established via Web UI tab');
                    if (!background) showToast('qBittorrent session ready', 'success');
                } else {
                    showToast('Could not establish a qBittorrent session', 'error');
                }
                resolve(ok);
            };

            const check = async (fromRetry = false) => {
                if (done || probing) return;
                probing = true;
                const ok = await probeSession();
                probing = false;
                if (done) return;
                if (ok) {
                    finish(true);
                } else if (fromRetry) {
                    showToast('Not signed in yet', 'error');
                    openModal(waitingHtml);
                }
            };

            const onSignal = (ok) => {
                if (ok) check();
                else openModal(failedHtml); // sign-in failed: the user has to step in
            };

            const onMessage = (e) => {
                const d = e.data;
                if (d && d.type === 'qbit-autologin' && d.nonce === nonce) onSignal(!!d.ok);
            };
            window.addEventListener('message', onMessage);

            let ticks = 0;
            let signalSeen = false;
            const timer = setInterval(() => {
                if (done) return;
                ticks++;
                if (!signalSeen) {
                    let r = null;
                    try { r = GM_getValue('qbit_autologin_result', null); } catch (e) { /* ignore */ }
                    if (r && r.nonce === nonce) {
                        signalSeen = true;
                        onSignal(!!r.ok);
                    }
                }
                // Tab closed itself (success path) or user closed it — check now
                if (handle && handle.isClosed()) check();
                // Fallback: poll the API every 2s regardless of signals
                if (ticks % 4 === 0) check();
                // A background tab that hasn't reported back may be suspended,
                // or the user may need to look at it — surface it at that point
                if (background && !modal && Date.now() - startedAt > BACKGROUND_ESCALATE_MS) {
                    openModal(stalledHtml);
                }
                if (Date.now() - startedAt > AUTOLOGIN_TIMEOUT_MS) finish(false);
            }, 500);

            if (background) {
                debugLog('qBittorrent: signing in from a background tab');
            } else {
                openModal(waitingHtml);
            }
        });
    }

    // Use native fetch for qBittorrent API (better cookie handling on Safari/iPadOS)
    // Note: Requires CSRF protection disabled in qBittorrent for Safari/iPadOS
    async function qbitRequestFetch(endpoint, method, data, headers = {}) {
        const url = `${CONFIG.qbittorrent.url}${endpoint}`;

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

        const fetchOptions = {
            method: method,
            credentials: 'include', // Send cookies
            headers: { ...headers },
            signal: controller.signal
        };

        if (data) {
            fetchOptions.body = data;
        }

        debugLog(`qBittorrent API (fetch): ${method} ${endpoint}`);

        try {
            const response = await fetch(url, fetchOptions);
            const responseText = await response.text();
            return {
                status: response.status,
                responseText: responseText,
                responseHeaders: [...response.headers.entries()].map(([k, v]) => `${k}: ${v}`).join('\n')
            };
        } catch (error) {
            console.error('Fetch error:', error);
            throw error;
        } finally {
            clearTimeout(timer);
        }
    }

    // Extract origin (scheme + host) from URL for CSRF headers
    function getOriginFromUrl(urlString) {
        try {
            const url = new URL(urlString);
            return url.origin; // Returns "https://example.com" without path
        } catch (e) {
            // Fallback: extract origin manually
            const match = urlString.match(/^(https?:\/\/[^\/]+)/);
            return match ? match[1] : urlString;
        }
    }

    // Use GM_xmlhttpRequest (works on desktop browsers, can set headers)
    function qbitRequestGM(endpoint, method, data, headers = {}, isLogin = false) {
        return new Promise((resolve, reject) => {
            const url = `${CONFIG.qbittorrent.url}${endpoint}`;
            const origin = getOriginFromUrl(CONFIG.qbittorrent.url);

            // Build headers with CSRF protection bypass
            // Origin must be just scheme+host (no path), Referer can include path
            const requestHeaders = {
                'Referer': CONFIG.qbittorrent.url + '/',
                'Origin': origin,
                ...headers
            };

            const requestOptions = {
                method: method,
                url: url,
                headers: requestHeaders,
                data: data,
                withCredentials: true,
                anonymous: false,
                timeout: REQUEST_TIMEOUT_MS,
                onload: function(response) {
                    resolve(response);
                },
                onerror: function(error) {
                    reject(error);
                },
                ontimeout: function() {
                    reject(new Error(`Request timed out after ${REQUEST_TIMEOUT_MS}ms: ${endpoint}`));
                }
            };

            // Add session cookie for authenticated requests
            // Only set if we have a real SID (not placeholder values)
            const hasRealSid = qbitSessionId &&
                              qbitSessionId !== 'no-sid-cookie' &&
                              qbitSessionId !== 'safari-auto';

            if (hasRealSid && !isLogin) {
                requestOptions.cookie = `SID=${qbitSessionId}`;
                requestHeaders['Cookie'] = `SID=${qbitSessionId}`;
                debugLog(`  → Cookie: SID=${qbitSessionId.substring(0, 8)}...`);
            } else if (!isLogin) {
                // No manual cookie - rely on withCredentials to send browser cookies
                debugLog(`  → Cookie: (relying on browser cookies via withCredentials)`);
            }

            debugLog(`qBittorrent API (GM): ${method} ${endpoint}`, isLogin ? '(login)' : `(SID: ${hasRealSid ? 'manual' : 'browser'})`);
            debugLog(`  → URL: ${url}`);
            debugLog(`  → Origin: ${origin}`);
            debugLog(`  → Referer: ${requestHeaders['Referer']}`);

            GM_xmlhttpRequest(requestOptions);
        });
    }

    // Smart request function - uses fetch on Safari/iPadOS or when forced, GM_xmlhttpRequest elsewhere
    async function qbitRequest(endpoint, method, data, headers = {}, isLogin = false) {
        if (shouldUseFetch()) {
            return qbitRequestFetch(endpoint, method, data, headers);
        } else {
            return qbitRequestGM(endpoint, method, data, headers, isLogin);
        }
    }

    // Serialize logins so concurrent addTorrent calls share one in-flight
    // login instead of racing and clobbering each other's SID
    let loginPromise = null;
    // Why the last login failed: 'credentials' | 'denied' | 'network' | null
    let lastLoginError = null;
    // Response headers from the last successful login (source of the SID attributes)
    let lastLoginHeaders = '';

    function qbitLogin() {
        if (loginPromise) return loginPromise;
        loginPromise = doLogin().finally(() => {
            loginPromise = null;
        });
        return loginPromise;
    }

    async function doLogin() {
        lastLoginError = null;
        try {
            const formData = `username=${encodeURIComponent(CONFIG.qbittorrent.username)}&password=${encodeURIComponent(CONFIG.qbittorrent.password)}`;

            const response = await qbitRequest(
                '/api/v2/auth/login',
                'POST',
                formData,
                { 'Content-Type': 'application/x-www-form-urlencoded' },
                true // isLogin flag
            );

            if (response.status === 200 && response.responseText === 'Ok.') {
                // When using fetch, cookies are handled by the browser automatically
                // When using GM_xmlhttpRequest, extract SID from response headers
                if (!shouldUseFetch()) {
                    const cookies = response.responseHeaders;
                    lastLoginHeaders = cookies || '';
                    debugLog('qBittorrent: Login response headers:', cookies);
                    const sidMatch = cookies.match(/SID=([^;]+)/i);
                    if (sidMatch) {
                        qbitSessionId = sidMatch[1];
                        GM_setValue('qbit_session', qbitSessionId);
                        debugLog('qBittorrent: Login successful, SID:', qbitSessionId.substring(0, 8) + '...');
                    } else {
                        console.warn('qBittorrent: Login succeeded but no SID cookie found in response');
                        // Even without explicit SID, mark as logged in (server may use different auth)
                        qbitSessionId = 'no-sid-cookie';
                    }
                } else {
                    // On Safari, mark as authenticated (browser handles cookie)
                    qbitSessionId = 'safari-auto';
                    debugLog('qBittorrent: Login successful (Safari - browser handles cookies)');
                }
                return true;
            } else if (response.status === 200) {
                // qBittorrent answers 200 "Fails." for a wrong username/password
                lastLoginError = 'credentials';
                showToast('qBittorrent: Invalid username or password', 'error');
                console.warn('qBittorrent login failed:', response.status, response.responseText);
                return false;
            } else if (response.status === 403 || response.status === 401) {
                // 403: IP banned after failed attempts; 401: CSRF/Origin check rejected us
                lastLoginError = 'denied';
                debugLog(`qBittorrent: ${response.status} on login - CSRF/Origin or cookie issue`);
                // On Safari the caller falls back to signing in via a Web UI tab
                if (!isSafari) {
                    showToast(`qBittorrent: Access denied (${response.status}) on login`, 'error');
                }
                return false;
            } else {
                lastLoginError = 'denied';
                showToast(`qBittorrent: Login failed (HTTP ${response.status})`, 'error');
                console.warn('qBittorrent login failed:', response.status, response.responseText);
                return false;
            }
        } catch (error) {
            lastLoginError = 'network';
            console.error('qBittorrent login error:', error);
            showToast('qBittorrent: Connection failed. Check your settings.', 'error');
            return false;
        }
    }

    async function ensureAuthenticated() {
        // When using fetch, try making a request first - browser may already have valid cookies
        if (shouldUseFetch()) {
            try {
                const response = await qbitRequest('/api/v2/app/version', 'GET', null);
                if (response.status === 200) {
                    debugLog('qBittorrent: Already authenticated (Safari cookies valid)');
                    qbitSessionId = 'safari-auto';
                    return true;
                }
            } catch (e) {
                debugLog('qBittorrent: Safari auth check failed, will login');
            }
            return await qbitLogin();
        }

        // Try to restore session from storage
        if (!qbitSessionId) {
            qbitSessionId = GM_getValue('qbit_session', null);
        }

        if (isSafari) {
            return await ensureAuthenticatedSafari();
        }

        // Check if we're already authenticated by making a simple API call
        if (qbitSessionId) {
            try {
                const response = await qbitRequest('/api/v2/app/version', 'GET', null);
                if (response.status === 200) {
                    return true;
                }
                // Session expired, clear it
                qbitSessionId = null;
                GM_setValue('qbit_session', null);
            } catch (e) {
                // Not authenticated, proceed to login
                qbitSessionId = null;
            }
        }

        return await qbitLogin();
    }

    // Safari: a manual Cookie header is ignored, so what matters is whether
    // Safari's own cookie jar holds a valid SID. Probe first, then try the
    // normal login and verify it stuck, and finally fall back to signing in
    // from a qBittorrent Web UI tab (needed on iOS/iPadOS).
    async function ensureAuthenticatedSafari() {
        if (await probeSession()) {
            if (!qbitSessionId) qbitSessionId = 'safari-auto';
            debugLog('qBittorrent: Already authenticated (Safari cookies valid)');
            return true;
        }
        qbitSessionId = null;
        GM_setValue('qbit_session', null);

        const loggedIn = await qbitLogin();
        if (loggedIn && await probeSession()) {
            setSafariNeedsTabLogin(false);
            return true;
        }
        if (!loggedIn && lastLoginError === 'credentials') {
            return false; // the Web UI tab would fail the same way
        }

        // The login worked but its Set-Cookie never reached Safari's jar
        // (typical on iOS/iPadOS). If the cookie API is available we can put
        // the SID there ourselves, which keeps the sign-in completely silent.
        if (loggedIn && await plantSessionCookie(qbitSessionId, lastLoginHeaders)) {
            setSafariNeedsTabLogin(false);
            return true;
        }

        if (loggedIn || lastLoginError === 'denied') {
            setSafariNeedsTabLogin(true);
        }

        debugLog('qBittorrent: Session not usable after login, signing in via Web UI tab');
        return await autoLoginViaTab();
    }

    async function addTorrentByUrl(url, torrentName = '', retryCount = 0) {
        if (!await ensureAuthenticated()) {
            return false;
        }

        try {
            // Build form data using URLSearchParams for proper encoding
            const formData = new URLSearchParams();
            formData.append('urls', url);

            // Add save path if configured
            if (CONFIG.savePath) {
                formData.append('savepath', CONFIG.savePath);
            }

            // Add category if configured
            if (CONFIG.category) {
                formData.append('category', CONFIG.category);
            }

            // Auto-start setting ('paused' for qBittorrent 4.x, 'stopped' for 5.x)
            if (!CONFIG.autoStart) {
                formData.append('paused', 'true');
                formData.append('stopped', 'true');
            }

            // Automatic Torrent Management - lets qBittorrent manage save paths
            // If user has configured a custom savePath, disable autoTMM so their path is used
            const useAutoTMM = CONFIG.autoTMM && !CONFIG.savePath;
            formData.append('autoTMM', useAutoTMM ? 'true' : 'false');

            const response = await qbitRequest(
                '/api/v2/torrents/add',
                'POST',
                formData.toString(),
                { 'Content-Type': 'application/x-www-form-urlencoded' }
            );

            if (response.status === 200 && response.responseText === 'Ok.') {
                const displayName = torrentName || (url.startsWith('magnet:') ? 'Magnet link' : 'Torrent');
                showToast(`Added: ${displayName}`, 'success');
                return true;
            } else if (response.status === 415) {
                showToast('qBittorrent: Torrent file is not valid', 'error');
                console.warn('qBittorrent 415 error - invalid torrent. URL:', url);
                return false;
            } else if (response.status === 403 && retryCount < 1) {
                // Session might have expired or CSRF issue - force re-login and retry
                debugLog('qBittorrent: Got 403, forcing re-login...');
                qbitSessionId = null;
                GM_setValue('qbit_session', null);
                return await addTorrentByUrl(url, torrentName, retryCount + 1);
            } else {
                showToast(`qBittorrent: Failed to add torrent (${response.status})`, 'error');
                console.warn('qBittorrent add torrent failed:', response.status, response.responseText, response.responseHeaders);
                return false;
            }
        } catch (error) {
            showToast('qBittorrent: Error adding torrent', 'error');
            console.error('Add torrent error:', error);
            return false;
        }
    }

    async function addTorrentByFile(fileBlob, fileName, retryCount = 0) {
        if (!await ensureAuthenticated()) {
            return false;
        }

        try {
            // Read file as ArrayBuffer for proper binary handling
            const reader = new FileReader();
            const arrayBuffer = await new Promise((resolve, reject) => {
                reader.onload = () => resolve(reader.result);
                reader.onerror = reject;
                reader.readAsArrayBuffer(fileBlob);
            });

            const fileBytes = new Uint8Array(arrayBuffer);

            // Build multipart form data with proper binary handling
            const boundary = '----WebKitFormBoundary' + Math.random().toString(36).slice(2);

            // Helper to convert string to Uint8Array
            const stringToBytes = (str) => new TextEncoder().encode(str);

            // The filename comes from the page URL; quotes or CR/LF in it would
            // corrupt the Content-Disposition header
            const safeFileName = fileName.replace(/[\r\n"\\]/g, '_');

            // Build the parts
            const parts = [];

            // Add torrent file part
            parts.push(stringToBytes(`--${boundary}\r\nContent-Disposition: form-data; name="torrents"; filename="${safeFileName}"\r\nContent-Type: application/x-bittorrent\r\n\r\n`));
            parts.push(fileBytes);
            parts.push(stringToBytes('\r\n'));

            // Add save path if configured
            if (CONFIG.savePath) {
                parts.push(stringToBytes(`--${boundary}\r\nContent-Disposition: form-data; name="savepath"\r\n\r\n${CONFIG.savePath}\r\n`));
            }

            // Add category if configured
            if (CONFIG.category) {
                parts.push(stringToBytes(`--${boundary}\r\nContent-Disposition: form-data; name="category"\r\n\r\n${CONFIG.category}\r\n`));
            }

            // Auto-start setting ('paused' for qBittorrent 4.x, 'stopped' for 5.x)
            if (!CONFIG.autoStart) {
                parts.push(stringToBytes(`--${boundary}\r\nContent-Disposition: form-data; name="paused"\r\n\r\ntrue\r\n`));
                parts.push(stringToBytes(`--${boundary}\r\nContent-Disposition: form-data; name="stopped"\r\n\r\ntrue\r\n`));
            }

            // Automatic Torrent Management - lets qBittorrent manage save paths
            // If user has configured a custom savePath, disable autoTMM so their path is used
            const useAutoTMM = CONFIG.autoTMM && !CONFIG.savePath;
            parts.push(stringToBytes(`--${boundary}\r\nContent-Disposition: form-data; name="autoTMM"\r\n\r\n${useAutoTMM ? 'true' : 'false'}\r\n`));

            // End boundary
            parts.push(stringToBytes(`--${boundary}--\r\n`));

            // Concatenate all parts into single Uint8Array
            const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
            const formBody = new Uint8Array(totalLength);
            let offset = 0;
            for (const part of parts) {
                formBody.set(part, offset);
                offset += part.length;
            }

            // Send using binary-aware request
            const response = await qbitRequestBinary(
                '/api/v2/torrents/add',
                formBody,
                boundary
            );

            if (response.status === 200 && response.responseText === 'Ok.') {
                showToast(`Added: ${fileName}`, 'success');
                return true;
            } else if (response.status === 403 && retryCount < 1) {
                // Session might have expired or CSRF issue - force re-login and retry
                debugLog('qBittorrent: Got 403, forcing re-login...');
                qbitSessionId = null;
                GM_setValue('qbit_session', null);
                return await addTorrentByFile(fileBlob, fileName, retryCount + 1);
            } else {
                showToast(`qBittorrent: Failed to add torrent (${response.status})`, 'error');
                console.warn('qBittorrent upload failed:', response.status, response.responseText);
                return false;
            }
        } catch (error) {
            showToast('qBittorrent: Error uploading torrent file', 'error');
            console.error('Upload torrent error:', error);
            return false;
        }
    }

    // Binary-aware request function for file uploads
    async function qbitRequestBinary(endpoint, binaryData, boundary) {
        const url = `${CONFIG.qbittorrent.url}${endpoint}`;

        // Use fetch on Safari/iPadOS or when forced, for better cookie handling
        if (shouldUseFetch()) {
            debugLog('qBittorrent API (fetch binary): POST', endpoint);
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
            try {
                const response = await fetch(url, {
                    method: 'POST',
                    credentials: 'include',
                    headers: {
                        'Content-Type': `multipart/form-data; boundary=${boundary}`
                    },
                    body: binaryData.buffer,
                    signal: controller.signal
                });
                const responseText = await response.text();
                return {
                    status: response.status,
                    responseText: responseText
                };
            } catch (error) {
                console.error('Fetch binary error:', error);
                throw error;
            } finally {
                clearTimeout(timer);
            }
        }

        // Use GM_xmlhttpRequest for non-Safari
        return new Promise((resolve, reject) => {
            const origin = getOriginFromUrl(CONFIG.qbittorrent.url);
            const requestHeaders = {
                'Referer': CONFIG.qbittorrent.url + '/',
                'Origin': origin,
                'Content-Type': `multipart/form-data; boundary=${boundary}`
            };

            const requestOptions = {
                method: 'POST',
                url: url,
                headers: requestHeaders,
                data: binaryData.buffer,
                binary: true,
                withCredentials: true,
                anonymous: false,
                timeout: REQUEST_TIMEOUT_MS,
                onload: function(response) {
                    resolve(response);
                },
                onerror: function(error) {
                    reject(error);
                },
                ontimeout: function() {
                    reject(new Error(`Upload timed out after ${REQUEST_TIMEOUT_MS}ms: ${endpoint}`));
                }
            };

            // Add session cookie only if we have a real SID
            const hasRealSid = qbitSessionId &&
                              qbitSessionId !== 'no-sid-cookie' &&
                              qbitSessionId !== 'safari-auto';

            if (hasRealSid) {
                requestOptions.cookie = `SID=${qbitSessionId}`;
                requestHeaders['Cookie'] = `SID=${qbitSessionId}`;
            }

            debugLog('qBittorrent API (GM binary): POST', endpoint, hasRealSid ? '(manual SID)' : '(browser cookies)');

            GM_xmlhttpRequest(requestOptions);
        });
    }

    // ============================================
    // TORRENT FILE DOWNLOAD HANDLING
    // ============================================

    function downloadTorrentFile(url) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: url,
                responseType: 'blob',
                // This will include cookies from the current site session
                // which handles authenticated downloads
                withCredentials: true,
                anonymous: false,
                timeout: REQUEST_TIMEOUT_MS,
                onload: function(response) {
                    if (response.status === 200) {
                        resolve(response.response);
                    } else {
                        reject(new Error(`HTTP ${response.status}`));
                    }
                },
                onerror: function(error) {
                    reject(error);
                },
                ontimeout: function() {
                    reject(new Error(`Download timed out after ${REQUEST_TIMEOUT_MS}ms`));
                }
            });
        });
    }

    // Bencoded torrent files always start with 'd' (a dictionary). Trackers
    // with an expired session often return an HTML login page with HTTP 200,
    // which would otherwise be uploaded and rejected as an invalid torrent.
    async function looksLikeTorrentFile(blob) {
        try {
            const head = new Uint8Array(await blob.slice(0, 1).arrayBuffer());
            return head.length > 0 && head[0] === 0x64; // 'd'
        } catch (e) {
            return true; // can't inspect the blob - don't block the attempt
        }
    }

    async function handleTorrentDownload(url, fileName) {
        showToast('Downloading torrent file...', 'info');

        try {
            const blob = await downloadTorrentFile(url);
            if (!(await looksLikeTorrentFile(blob))) {
                // Likely an HTML error/login page - let qBittorrent fetch the
                // URL itself rather than uploading garbage
                debugLog('Downloaded file is not bencoded, trying URL method');
                showToast('Tracker sent a non-torrent response (login page?), trying URL method...', 'info');
                return await addTorrentByUrl(url, fileName);
            }
            return await addTorrentByFile(blob, fileName);
        } catch (error) {
            // If download failed, try adding by URL (qBittorrent will download it)
            debugLog('Direct download failed, trying URL method:', error);
            return await addTorrentByUrl(url, fileName);
        }
    }

    // Save a blob to the user's computer via a temporary download link
    function saveBlobToComputer(blob, fileName) {
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = fileName;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        a.remove();
        // Revoke after a tick so the download has a chance to start
        setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
    }

    // Download the .torrent file and save it to the local computer instead of
    // sending it to qBittorrent. Uses the current site session cookies, so it
    // works on authenticated trackers just like the qBittorrent path.
    async function handleLocalDownload(url, fileName) {
        showToast('Downloading torrent file...', 'info');

        try {
            const blob = await downloadTorrentFile(url);
            if (!(await looksLikeTorrentFile(blob))) {
                // Still save it so the user can inspect, but warn them
                showToast('Warning: file does not look like a torrent (tracker login page?)', 'error');
            }
            saveBlobToComputer(blob, fileName);
            showToast(`Saved: ${fileName}`, 'success');
        } catch (error) {
            console.error('Local download failed:', error);
            showToast('Could not download torrent file', 'error');
        }
    }

    // ============================================
    // LINK INTERCEPTION
    // ============================================

    function extractTorrentName(url) {
        url = String(url);

        // Try to extract name from magnet link
        if (isMagnetUrl(url)) {
            try {
                // URLSearchParams handles decoding (including '+' as space)
                // and doesn't throw on malformed percent-encoding
                const query = url.slice(url.indexOf('?') + 1);
                const dn = new URLSearchParams(query).get('dn');
                if (dn) return dn;
            } catch (e) {
                // Malformed magnet - fall through
            }
            return 'Magnet link';
        }

        // Try to extract filename from URL
        try {
            const urlObj = new URL(url);
            const pathParts = urlObj.pathname.split('/');
            const fileName = pathParts[pathParts.length - 1];
            if (fileName && fileName.toLowerCase().includes('.torrent')) {
                return safeDecodeURIComponent(fileName.replace(/\.torrent/i, ''));
            }
        } catch (e) {
            // Invalid URL
        }

        return url.length > 50 ? url.substring(0, 50) + '...' : url;
    }

    function isTorrentUrl(url) {
        if (!url) return false;
        const lowerUrl = String(url).toLowerCase();
        return lowerUrl.endsWith('.torrent') ||
               lowerUrl.includes('.torrent?') ||
               lowerUrl.includes('/download/torrent') ||
               lowerUrl.includes('/get_torrent') ||
               // 'action=download' alone matches ordinary downloads on
               // non-torrent sites, so require a torrent hint alongside it
               (lowerUrl.includes('action=download') && lowerUrl.includes('torrent')) ||
               // Common torrent site patterns
               /\/torrent\/\d+\/download/.test(lowerUrl) ||
               /\/torrents\/download\/\d+/.test(lowerUrl) ||
               /download\.php\?.*torrent/i.test(lowerUrl);
    }

    function isMagnetUrl(url) {
        // Coerce: pages sometimes pass URL objects to window.open
        return !!url && String(url).toLowerCase().startsWith('magnet:');
    }

    function handleLink(url, event, linkName = '') {
        const torrentName = extractTorrentName(url);
        // Link text/title often carries the release name on download.php URLs.
        const followName = [torrentName, linkName, document.title].find(name => parseShowHint(name).season) || linkName || torrentName;

        if (CONFIG.showConfirmation) {
            event.preventDefault();
            event.stopPropagation();

            const content = `
                <p>Send this to qBittorrent?</p>
                <div class="qbit-torrent-name">${escapeHtml(torrentName)}</div>
            `;

            const magnet = isMagnetUrl(url);

            // Secondary action: for .torrent links, download the file locally.
            // Magnet links aren't files, so offer to hand off to the default app instead.
            const extraButtons = magnet
                ? [{
                    label: '🧲 Open in App',
                    onClick: () => { window.location.href = url; }
                  }]
                : [{
                    label: '⬇️ Download File',
                    onClick: () => handleLocalDownload(url, torrentName + '.torrent')
                  }];

            if (CONFIG.daemon.enabled) {
                extraButtons.push({ label: 'Add & follow TV show…', onClick: () => showFollowModal(followName, url) });
            }
            prewarmSafariSession();
            showModal('🧲 Add Torrent', content, async () => {
                // Runs synchronously inside the tap: may open the sign-in tab
                if (!await signInFromGestureIfNeeded()) return;
                if (magnet) {
                    await addTorrentByUrl(url, torrentName);
                } else {
                    await handleTorrentDownload(url, torrentName + '.torrent');
                }
            }, null, { extraButtons });
        } else {
            event.preventDefault();
            event.stopPropagation();

            // Runs synchronously inside the click: may open the sign-in tab
            signInFromGestureIfNeeded().then((ok) => {
                if (!ok) return;
                if (isMagnetUrl(url)) {
                    addTorrentByUrl(url, torrentName);
                } else {
                    handleTorrentDownload(url, torrentName + '.torrent');
                }
            });
        }
    }

    // Click event listener
    function setupClickInterceptor() {
        document.addEventListener('click', function(event) {
            // composedPath finds anchors inside shadow DOM (event.target is
            // retargeted to the shadow host); fall back to walking parents.
            // The typeof check skips SVG <a>, whose href is an object.
            let target = null;
            if (event.composedPath) {
                target = event.composedPath().find(
                    (el) => el.tagName === 'A' && typeof el.href === 'string'
                ) || null;
            } else {
                let el = event.target;
                while (el && el.tagName !== 'A') {
                    el = el.parentElement;
                }
                target = el;
            }

            if (!target || !target.href) return;

            const url = target.href;

            if (isMagnetUrl(url) || isTorrentUrl(url)) {
                handleLink(url, event, target.getAttribute('title') || target.textContent.trim());
            }
        }, true); // Use capture phase to intercept before other handlers
    }

    // Intercept magnet: protocol handler
    function setupMagnetProtocolInterceptor() {
        // Override window.open for magnet links
        const originalOpen = window.open;
        window.open = function(url, ...args) {
            if (isMagnetUrl(url)) {
                // Coerce - pages may pass a URL object instead of a string
                const magnetUrl = String(url);
                handleLink(magnetUrl, { preventDefault() {}, stopPropagation() {} });
                return null;
            }
            return originalOpen.call(this, url, ...args);
        };
    }

    // Handle navigation to .torrent URLs
    function setupNavigationInterceptor() {
        // Check if current page is a .torrent download
        if (isTorrentUrl(window.location.href)) {
            // Intercept the download
            const fileName = extractTorrentName(window.location.href) + '.torrent';
            handleTorrentDownload(window.location.href, fileName);
        }
    }

    // ============================================
    // MENU COMMANDS
    // ============================================

    GM_registerMenuCommand('⚙️ Configure qBittorrent', showConfigModal);

    GM_registerMenuCommand('🔗 Add Torrent by URL', () => {
        const input = prompt('Enter torrent URL or magnet link:');
        const url = input && input.trim();
        if (url) {
            handleLink(url, { preventDefault() {}, stopPropagation() {} });
        }
    });

    GM_registerMenuCommand('📺 Follow TV show with qbt-dl', () => showFollowModal(document.title));

    GM_registerMenuCommand('🔌 Test Connection', async () => {
        showToast('Testing connection...', 'info');
        debugLog('qBittorrent: Starting connection test...');
        debugLog('qBittorrent: Current SID:', qbitSessionId ? qbitSessionId.substring(0, 8) + '...' : 'none');

        const success = await ensureAuthenticated();
        debugLog('qBittorrent: Auth result:', success, 'SID after auth:', qbitSessionId ? qbitSessionId.substring(0, 8) + '...' : 'none');

        if (success) {
            try {
                const response = await qbitRequest('/api/v2/app/version', 'GET', null);
                debugLog('qBittorrent: Test response:', response.status, response.responseText);
                if (response.status === 200) {
                    showToast(`Connected to qBittorrent ${response.responseText}`, 'success');
                } else {
                    showToast(`Connection issue: HTTP ${response.status}`, 'error');
                    console.warn('qBittorrent test failed - full response:', response);
                }
            } catch (e) {
                showToast('Connected but could not get version', 'info');
                console.error('qBittorrent test error:', e);
            }
        }
    });

    // ============================================
    // INITIALIZATION
    // ============================================

    function init() {
        // If this is the qBittorrent Web UI opened by autoLoginViaTab(),
        // sign in same-origin and hand the session back — nothing else to do here
        const autoLoginMarker = getAutoLoginMarker();
        if (autoLoginMarker) {
            debugLog('qBittorrent: Web UI auto sign-in page detected');
            runAutoLoginPage(autoLoginMarker.nonce, autoLoginMarker.background);
            return;
        }

        // Wait for DOM to be ready
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => {
                setupClickInterceptor();
                setupMagnetProtocolInterceptor();
                setupNavigationInterceptor();
            });
        } else {
            setupClickInterceptor();
            setupMagnetProtocolInterceptor();
            setupNavigationInterceptor();
        }

        // Without a confirmation dialog there is no moment to pre-warm before
        // the click, so probe at load on devices known to need the tab sign-in
        if (isSafari && safariNeedsTabLogin && !CONFIG.showConfirmation) {
            prewarmSafariSession();
        }

        debugLog('qBittorrent Torrent Interceptor loaded');
        debugLog('Browser detection:', isSafari ? 'Safari/iPadOS' : 'Other browser');
        debugLog('Touch points:', navigator.maxTouchPoints);
        debugLog('Fetch mode:', forceFetchMode ? 'ON' : 'OFF');
        debugLog('Using:', shouldUseFetch() ? 'fetch API (CORS required)' : 'GM_xmlhttpRequest (CORS bypass)');

        if (isSafari) {
            debugLog('%c📱 Safari/iPadOS detected', 'color: #007aff; font-weight: bold');
            debugLog('  Using GM_xmlhttpRequest to bypass CORS restrictions.');
            debugLog('  If the session never sticks (iOS/iPadOS), the script signs in via a Web UI tab automatically.');
        }

        if (shouldUseFetch()) {
            debugLog('%c⚠️ Fetch mode enabled - CORS required:', 'color: orange; font-weight: bold');
            debugLog('  1. Open qBittorrent Web UI → Options → Web UI');
            debugLog('  2. Disable "Enable Cross-Site Request Forgery (CSRF) protection"');
            debugLog('  3. Configure reverse proxy CORS headers if using one');
        }
    }

    init();
})();
