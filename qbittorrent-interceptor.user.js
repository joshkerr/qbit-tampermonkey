// ==UserScript==
// @name         qBittorrent Torrent Interceptor
// @namespace    https://github.com/joshkerr/qbit-tampermonkey
// @version      1.10.0
// @description  Intercept torrent downloads and magnet links, send them to qBittorrent or download locally
// @author       joshkerr
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_notification
// @grant        GM_addStyle
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
        .qbit-modal input[type="password"] {
            width: 100%;
            padding: 10px 12px;
            border: 1px solid #ccc;
            border-radius: 6px;
            font-size: 14px;
            box-sizing: border-box;
            margin-top: 4px;
        }
        .qbit-modal-dark input[type="text"],
        .qbit-modal-dark input[type="password"] {
            background: #2d2d2d;
            border-color: #444;
            color: #fff;
        }
        .qbit-modal-buttons {
            display: flex;
            justify-content: flex-end;
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
            document.removeEventListener('keydown', onKeydown, true);
            overlay.remove();
        };
        const cancel = () => {
            close();
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
            close();
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
                <div class="qbit-actions-header">Quick Actions</div>
                <div class="qbit-actions-grid">
                    <button class="qbit-action-btn" id="qbit-act-relogin">🔄 Force Re-login</button>
                    <button class="qbit-action-btn" id="qbit-act-webui">📊 Open Web UI</button>
                    <button class="qbit-action-btn" id="qbit-act-session">🔑 Establish Session</button>
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

        // Quick action: Force Re-login
        modal.querySelector('#qbit-act-relogin').onclick = async () => {
            qbitSessionId = null;
            GM_setValue('qbit_session', null);
            closeConfig();
            showToast('Session cleared, logging in...', 'info');
            const success = await qbitLogin();
            if (success) {
                showToast('Re-login successful!', 'success');
            }
        };

        // Quick action: Open Web UI (keep modal open so user can continue configuring)
        modal.querySelector('#qbit-act-webui').onclick = () => {
            window.open(CONFIG.qbittorrent.url, '_blank', 'noopener,noreferrer');
        };

        // Quick action: Establish Session (Safari/iPadOS) — closes modal to show session helper
        modal.querySelector('#qbit-act-session').onclick = async () => {
            closeConfig();
            const established = await establishSafariSession();
            if (established) {
                await ensureAuthenticated();
            } else {
                showToast('Could not establish session', 'error');
            }
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

    // Track if we've shown the Safari session helper
    let safariSessionPopup = null;
    let safariSessionEstablished = GM_getValue('qbit_safari_session', false);

    // Helper to establish session on Safari/iPadOS by opening qBittorrent in a popup
    async function establishSafariSession() {
        return new Promise((resolve) => {
            const popupWidth = 600;
            const popupHeight = 500;
            const left = (screen.width - popupWidth) / 2;
            const top = (screen.height - popupHeight) / 2;

            showToast('Opening qBittorrent to establish session...', 'info');

            safariSessionPopup = window.open(
                CONFIG.qbittorrent.url,
                'qbit_session',
                `width=${popupWidth},height=${popupHeight},left=${left},top=${top},resizable=yes`
            );

            if (!safariSessionPopup) {
                showToast('Popup blocked! Please allow popups for this site.', 'error');
                resolve(false);
                return;
            }

            // Show instructions
            showModal(
                '🔑 Establish qBittorrent Session',
                `<p>A popup window has opened to qBittorrent.</p>
                 <p><strong>Instructions:</strong></p>
                 <ol style="margin: 10px 0; padding-left: 20px;">
                   <li>Log in to qBittorrent in the popup</li>
                   <li>Once logged in, click "Done" below</li>
                 </ol>
                 <p style="color: #888; font-size: 12px;">This establishes browser cookies needed for Safari/iPadOS.</p>`,
                () => {
                    // User clicked Done
                    if (safariSessionPopup && !safariSessionPopup.closed) {
                        safariSessionPopup.close();
                    }
                    safariSessionPopup = null;
                    safariSessionEstablished = true;
                    GM_setValue('qbit_safari_session', true);
                    showToast('Session established! Retrying...', 'success');
                    resolve(true);
                },
                () => {
                    // User clicked Cancel
                    if (safariSessionPopup && !safariSessionPopup.closed) {
                        safariSessionPopup.close();
                    }
                    safariSessionPopup = null;
                    resolve(false);
                },
                { confirmLabel: 'Done - I\'m logged in' }
            );
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

    function qbitLogin(offerSafariHelper = true) {
        if (loginPromise) return loginPromise;
        loginPromise = doLogin(offerSafariHelper).finally(() => {
            loginPromise = null;
        });
        return loginPromise;
    }

    async function doLogin(offerSafariHelper) {
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
            } else if (response.status === 403) {
                debugLog('qBittorrent: 403 on login - may be CSRF or cookie issue');
                // On Safari, 403 might be due to cookie/CORS issues
                if (isSafari && offerSafariHelper) {
                    debugLog('qBittorrent: Safari detected, offering session helper');
                    const established = await establishSafariSession();
                    if (established) {
                        // Retry login after session established.
                        // Call doLogin directly: qbitLogin would return the
                        // still-pending loginPromise (this call) and deadlock.
                        return await doLogin(false);
                    }
                }
                showToast('qBittorrent: Access denied (403). Try "Establish Session" from menu.', 'error');
                return false;
            } else {
                showToast('qBittorrent: Invalid username or password', 'error');
                console.warn('qBittorrent login failed:', response.status, response.responseText);
                return false;
            }
        } catch (error) {
            console.error('qBittorrent login error:', error);
            // On Safari, network errors might be CORS issues
            if (isSafari && offerSafariHelper) {
                debugLog('qBittorrent: Safari connection error, offering session helper');
                const established = await establishSafariSession();
                if (established) {
                    return await doLogin(false);
                }
            }
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

        // For non-Safari: try to restore session from storage
        if (!qbitSessionId) {
            qbitSessionId = GM_getValue('qbit_session', null);
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
                await addTorrentByUrl(url, fileName);
                return;
            }
            await addTorrentByFile(blob, fileName);
        } catch (error) {
            // If download failed, try adding by URL (qBittorrent will download it)
            debugLog('Direct download failed, trying URL method:', error);
            await addTorrentByUrl(url, fileName);
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

    function handleLink(url, event) {
        const torrentName = extractTorrentName(url);

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

            showModal('🧲 Add Torrent', content, async () => {
                if (magnet) {
                    await addTorrentByUrl(url, torrentName);
                } else {
                    await handleTorrentDownload(url, torrentName + '.torrent');
                }
            }, null, { extraButtons });
        } else {
            event.preventDefault();
            event.stopPropagation();

            if (isMagnetUrl(url)) {
                addTorrentByUrl(url, torrentName);
            } else {
                handleTorrentDownload(url, torrentName + '.torrent');
            }
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
                handleLink(url, event);
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
                const torrentName = extractTorrentName(magnetUrl);
                if (CONFIG.showConfirmation) {
                    const content = `
                        <p>Send this to qBittorrent?</p>
                        <div class="qbit-torrent-name">${escapeHtml(torrentName)}</div>
                    `;
                    showModal('🧲 Add Torrent', content, async () => {
                        await addTorrentByUrl(magnetUrl, torrentName);
                    }, null, {
                        extraButtons: [{
                            label: '🧲 Open in App',
                            onClick: () => { window.location.href = magnetUrl; }
                        }]
                    });
                } else {
                    addTorrentByUrl(magnetUrl, torrentName);
                }
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
            if (isMagnetUrl(url)) {
                addTorrentByUrl(url, extractTorrentName(url));
            } else {
                handleTorrentDownload(url, extractTorrentName(url) + '.torrent');
            }
        }
    });

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

        debugLog('qBittorrent Torrent Interceptor loaded');
        debugLog('Browser detection:', isSafari ? 'Safari/iPadOS' : 'Other browser');
        debugLog('Touch points:', navigator.maxTouchPoints);
        debugLog('Fetch mode:', forceFetchMode ? 'ON' : 'OFF');
        debugLog('Using:', shouldUseFetch() ? 'fetch API (CORS required)' : 'GM_xmlhttpRequest (CORS bypass)');

        if (isSafari) {
            debugLog('%c📱 Safari/iPadOS detected', 'color: #007aff; font-weight: bold');
            debugLog('  Using GM_xmlhttpRequest to bypass CORS restrictions.');
            debugLog('  If you experience 403 errors, use the "Establish Session" menu option.');
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
