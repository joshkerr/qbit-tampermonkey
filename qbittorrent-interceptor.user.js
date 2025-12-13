// ==UserScript==
// @name         qBittorrent Torrent Interceptor
// @namespace    https://github.com/joshkerr/qbit-tampermonkey
// @version      1.3.0
// @description  Intercept torrent downloads and magnet links, send them to qBittorrent
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
    const CONFIG = {
        // qBittorrent Web UI settings
        qbittorrent: {
            url: GM_getValue('qbit_url', 'http://localhost:8080'),
            username: GM_getValue('qbit_username', 'admin'),
            password: GM_getValue('qbit_password', 'adminadmin'),
        },
        // Default save path (leave empty for qBittorrent default)
        savePath: GM_getValue('qbit_savepath', ''),
        // Category for added torrents (leave empty for none)
        category: GM_getValue('qbit_category', ''),
        // Automatically start torrent after adding
        autoStart: GM_getValue('qbit_autostart', true),
        // Show notifications
        showNotifications: GM_getValue('qbit_notifications', true),
        // Show confirmation dialog before adding
        showConfirmation: GM_getValue('qbit_confirmation', true),
    };

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
    `);

    // ============================================
    // UTILITY FUNCTIONS
    // ============================================

    function showToast(message, type = 'info') {
        if (!CONFIG.showNotifications) return;

        const toast = document.createElement('div');
        toast.className = `qbit-toast qbit-toast-${type}`;
        toast.textContent = message;
        document.body.appendChild(toast);

        setTimeout(() => {
            toast.style.animation = 'qbit-slide-in 0.3s ease reverse';
            setTimeout(() => toast.remove(), 300);
        }, 4000);
    }

    function isDarkMode() {
        return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    }

    function showModal(title, content, onConfirm, onCancel) {
        const overlay = document.createElement('div');
        overlay.className = 'qbit-modal-overlay';

        const modal = document.createElement('div');
        modal.className = `qbit-modal ${isDarkMode() ? 'qbit-modal-dark' : ''}`;

        modal.innerHTML = `
            <h2>${title}</h2>
            <div class="qbit-modal-content">${content}</div>
            <div class="qbit-modal-buttons">
                <button class="qbit-btn-secondary" id="qbit-cancel">Cancel</button>
                <button class="qbit-btn-primary" id="qbit-confirm">Add to qBittorrent</button>
            </div>
        `;

        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        document.getElementById('qbit-confirm').onclick = () => {
            overlay.remove();
            if (onConfirm) onConfirm();
        };

        document.getElementById('qbit-cancel').onclick = () => {
            overlay.remove();
            if (onCancel) onCancel();
        };

        overlay.onclick = (e) => {
            if (e.target === overlay) {
                overlay.remove();
                if (onCancel) onCancel();
            }
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
                    <input type="text" id="qbit-cfg-url" value="${CONFIG.qbittorrent.url}" placeholder="http://localhost:8080">
                </label>
                <label>
                    Username:
                    <input type="text" id="qbit-cfg-username" value="${CONFIG.qbittorrent.username}">
                </label>
                <label>
                    Password:
                    <input type="password" id="qbit-cfg-password" value="${CONFIG.qbittorrent.password}">
                </label>
                <label>
                    Default Save Path (optional):
                    <input type="text" id="qbit-cfg-savepath" value="${CONFIG.savePath}" placeholder="/downloads/torrents">
                </label>
                <label>
                    Category (optional):
                    <input type="text" id="qbit-cfg-category" value="${CONFIG.category}">
                </label>
            </div>
            <div class="qbit-modal-buttons">
                <button class="qbit-btn-secondary" id="qbit-cfg-cancel">Cancel</button>
                <button class="qbit-btn-primary" id="qbit-cfg-save">Save Settings</button>
            </div>
        `;

        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        document.getElementById('qbit-cfg-save').onclick = () => {
            const url = document.getElementById('qbit-cfg-url').value.replace(/\/$/, '');
            const username = document.getElementById('qbit-cfg-username').value;
            const password = document.getElementById('qbit-cfg-password').value;
            const savePath = document.getElementById('qbit-cfg-savepath').value;
            const category = document.getElementById('qbit-cfg-category').value;

            GM_setValue('qbit_url', url);
            GM_setValue('qbit_username', username);
            GM_setValue('qbit_password', password);
            GM_setValue('qbit_savepath', savePath);
            GM_setValue('qbit_category', category);

            CONFIG.qbittorrent.url = url;
            CONFIG.qbittorrent.username = username;
            CONFIG.qbittorrent.password = password;
            CONFIG.savePath = savePath;
            CONFIG.category = category;

            // Reset session to force re-auth
            qbitSessionId = null;

            overlay.remove();
            showToast('Settings saved!', 'success');
        };

        document.getElementById('qbit-cfg-cancel').onclick = () => {
            overlay.remove();
        };

        overlay.onclick = (e) => {
            if (e.target === overlay) overlay.remove();
        };
    }

    // ============================================
    // QBITTORRENT API
    // ============================================

    function qbitRequest(endpoint, method, data, headers = {}, isLogin = false) {
        return new Promise((resolve, reject) => {
            const url = `${CONFIG.qbittorrent.url}${endpoint}`;

            // Build headers with CSRF protection bypass
            // qBittorrent checks Referer and Origin headers for CSRF protection
            const requestHeaders = {
                'Referer': CONFIG.qbittorrent.url + '/',
                'Origin': CONFIG.qbittorrent.url,
                ...headers
            };

            // Build request options
            const requestOptions = {
                method: method,
                url: url,
                headers: requestHeaders,
                data: data,
                withCredentials: true,
                anonymous: false, // Ensure cookies are sent
                onload: function(response) {
                    resolve(response);
                },
                onerror: function(error) {
                    reject(error);
                }
            };

            // Add session cookie if we have one (for authenticated requests)
            // Use 'cookie' property for better cross-platform support (iPadOS/Safari)
            if (qbitSessionId && !isLogin) {
                // Try both methods for maximum compatibility
                requestOptions.cookie = `SID=${qbitSessionId}`;
                requestHeaders['Cookie'] = `SID=${qbitSessionId}`;
            }

            console.log(`qBittorrent API: ${method} ${endpoint}`, isLogin ? '(login)' : `(SID: ${qbitSessionId ? 'yes' : 'no'})`);

            GM_xmlhttpRequest(requestOptions);
        });
    }

    async function qbitLogin() {
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
                // Extract SID cookie from response headers
                const cookies = response.responseHeaders;
                console.log('qBittorrent: Login response headers:', cookies);
                const sidMatch = cookies.match(/SID=([^;]+)/i);
                if (sidMatch) {
                    qbitSessionId = sidMatch[1];
                    // Store session in GM storage for persistence
                    GM_setValue('qbit_session', qbitSessionId);
                    console.log('qBittorrent: Login successful, SID:', qbitSessionId.substring(0, 8) + '...');
                } else {
                    console.warn('qBittorrent: Login succeeded but no SID cookie found in response');
                }
                return true;
            } else if (response.status === 403) {
                showToast('qBittorrent: Too many failed login attempts. Try again later.', 'error');
                return false;
            } else {
                showToast('qBittorrent: Invalid username or password', 'error');
                console.log('qBittorrent login failed:', response.status, response.responseText);
                return false;
            }
        } catch (error) {
            showToast('qBittorrent: Connection failed. Check your settings.', 'error');
            console.error('qBittorrent login error:', error);
            return false;
        }
    }

    async function ensureAuthenticated() {
        // Try to restore session from storage
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
            // Build form data
            const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substr(2);
            let formBody = '';

            // Add URL
            formBody += `--${boundary}\r\n`;
            formBody += 'Content-Disposition: form-data; name="urls"\r\n\r\n';
            formBody += url + '\r\n';

            // Add save path if configured
            if (CONFIG.savePath) {
                formBody += `--${boundary}\r\n`;
                formBody += 'Content-Disposition: form-data; name="savepath"\r\n\r\n';
                formBody += CONFIG.savePath + '\r\n';
            }

            // Add category if configured
            if (CONFIG.category) {
                formBody += `--${boundary}\r\n`;
                formBody += 'Content-Disposition: form-data; name="category"\r\n\r\n';
                formBody += CONFIG.category + '\r\n';
            }

            // Auto-start setting
            if (!CONFIG.autoStart) {
                formBody += `--${boundary}\r\n`;
                formBody += 'Content-Disposition: form-data; name="paused"\r\n\r\n';
                formBody += 'true\r\n';
            }

            formBody += `--${boundary}--\r\n`;

            const response = await qbitRequest(
                '/api/v2/torrents/add',
                'POST',
                formBody,
                { 'Content-Type': `multipart/form-data; boundary=${boundary}` }
            );

            if (response.status === 200 && response.responseText === 'Ok.') {
                const displayName = torrentName || (url.startsWith('magnet:') ? 'Magnet link' : 'Torrent');
                showToast(`Added: ${displayName}`, 'success');
                return true;
            } else if (response.status === 415) {
                showToast('qBittorrent: Torrent file is not valid', 'error');
                return false;
            } else if (response.status === 403 && retryCount < 1) {
                // Session might have expired or CSRF issue - force re-login and retry
                console.log('qBittorrent: Got 403, forcing re-login...');
                qbitSessionId = null;
                GM_setValue('qbit_session', null);
                return await addTorrentByUrl(url, torrentName, retryCount + 1);
            } else {
                showToast(`qBittorrent: Failed to add torrent (${response.status})`, 'error');
                console.log('qBittorrent add torrent failed:', response.status, response.responseText, response.responseHeaders);
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
            const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substr(2);

            // Helper to convert string to Uint8Array
            const stringToBytes = (str) => new TextEncoder().encode(str);

            // Build the parts
            const parts = [];

            // Add torrent file part
            parts.push(stringToBytes(`--${boundary}\r\nContent-Disposition: form-data; name="torrents"; filename="${fileName}"\r\nContent-Type: application/x-bittorrent\r\n\r\n`));
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

            // Auto-start setting
            if (!CONFIG.autoStart) {
                parts.push(stringToBytes(`--${boundary}\r\nContent-Disposition: form-data; name="paused"\r\n\r\ntrue\r\n`));
            }

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
                console.log('qBittorrent: Got 403, forcing re-login...');
                qbitSessionId = null;
                GM_setValue('qbit_session', null);
                return await addTorrentByFile(fileBlob, fileName, retryCount + 1);
            } else {
                showToast(`qBittorrent: Failed to add torrent (${response.status})`, 'error');
                console.log('qBittorrent upload failed:', response.status, response.responseText);
                return false;
            }
        } catch (error) {
            showToast('qBittorrent: Error uploading torrent file', 'error');
            console.error('Upload torrent error:', error);
            return false;
        }
    }

    // Binary-aware request function for file uploads
    function qbitRequestBinary(endpoint, binaryData, boundary) {
        return new Promise((resolve, reject) => {
            const url = `${CONFIG.qbittorrent.url}${endpoint}`;

            const requestHeaders = {
                'Referer': CONFIG.qbittorrent.url + '/',
                'Origin': CONFIG.qbittorrent.url,
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
                onload: function(response) {
                    resolve(response);
                },
                onerror: function(error) {
                    reject(error);
                }
            };

            // Add session cookie using both methods for compatibility
            if (qbitSessionId) {
                requestOptions.cookie = `SID=${qbitSessionId}`;
                requestHeaders['Cookie'] = `SID=${qbitSessionId}`;
            }

            console.log('qBittorrent API: POST (binary)', endpoint, `(SID: ${qbitSessionId ? 'yes' : 'no'})`);

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
                onload: function(response) {
                    if (response.status === 200) {
                        resolve(response.response);
                    } else {
                        reject(new Error(`HTTP ${response.status}`));
                    }
                },
                onerror: function(error) {
                    reject(error);
                }
            });
        });
    }

    async function handleTorrentDownload(url, fileName) {
        showToast('Downloading torrent file...', 'info');

        try {
            const blob = await downloadTorrentFile(url);
            await addTorrentByFile(blob, fileName);
        } catch (error) {
            // If download failed, try adding by URL (qBittorrent will download it)
            console.log('Direct download failed, trying URL method:', error);
            await addTorrentByUrl(url, fileName);
        }
    }

    // ============================================
    // LINK INTERCEPTION
    // ============================================

    function extractTorrentName(url) {
        // Try to extract name from magnet link
        if (url.startsWith('magnet:')) {
            const dnMatch = url.match(/dn=([^&]+)/);
            if (dnMatch) {
                return decodeURIComponent(dnMatch[1].replace(/\+/g, ' '));
            }
            return 'Magnet link';
        }

        // Try to extract filename from URL
        try {
            const urlObj = new URL(url);
            const pathParts = urlObj.pathname.split('/');
            const fileName = pathParts[pathParts.length - 1];
            if (fileName && fileName.includes('.torrent')) {
                return decodeURIComponent(fileName.replace('.torrent', ''));
            }
        } catch (e) {
            // Invalid URL
        }

        return url.substring(0, 50) + '...';
    }

    function isTorrentUrl(url) {
        if (!url) return false;
        const lowerUrl = url.toLowerCase();
        return lowerUrl.endsWith('.torrent') ||
               lowerUrl.includes('.torrent?') ||
               lowerUrl.includes('/download/torrent') ||
               lowerUrl.includes('/get_torrent') ||
               lowerUrl.includes('action=download') ||
               // Common torrent site patterns
               /\/torrent\/\d+\/download/.test(lowerUrl) ||
               /download\.php\?.*torrent/i.test(lowerUrl);
    }

    function isMagnetUrl(url) {
        return url && url.toLowerCase().startsWith('magnet:');
    }

    function handleLink(url, event) {
        const torrentName = extractTorrentName(url);

        if (CONFIG.showConfirmation) {
            event.preventDefault();
            event.stopPropagation();

            const content = `
                <p>Send this to qBittorrent?</p>
                <div class="qbit-torrent-name">${torrentName}</div>
            `;

            showModal('🧲 Add Torrent', content, async () => {
                if (isMagnetUrl(url)) {
                    await addTorrentByUrl(url, torrentName);
                } else {
                    await handleTorrentDownload(url, torrentName + '.torrent');
                }
            });
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
            // Find the closest anchor element
            let target = event.target;
            while (target && target.tagName !== 'A') {
                target = target.parentElement;
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
            if (url && isMagnetUrl(url)) {
                const torrentName = extractTorrentName(url);
                if (CONFIG.showConfirmation) {
                    const content = `
                        <p>Send this to qBittorrent?</p>
                        <div class="qbit-torrent-name">${torrentName}</div>
                    `;
                    showModal('🧲 Add Torrent', content, async () => {
                        await addTorrentByUrl(url, torrentName);
                    });
                } else {
                    addTorrentByUrl(url, torrentName);
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
        const url = prompt('Enter torrent URL or magnet link:');
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
        console.log('qBittorrent: Starting connection test...');
        console.log('qBittorrent: Current SID:', qbitSessionId ? qbitSessionId.substring(0, 8) + '...' : 'none');

        const success = await ensureAuthenticated();
        console.log('qBittorrent: Auth result:', success, 'SID after auth:', qbitSessionId ? qbitSessionId.substring(0, 8) + '...' : 'none');

        if (success) {
            try {
                const response = await qbitRequest('/api/v2/app/version', 'GET', null);
                console.log('qBittorrent: Test response:', response.status, response.responseText);
                if (response.status === 200) {
                    showToast(`Connected to qBittorrent ${response.responseText}`, 'success');
                } else {
                    showToast(`Connection issue: HTTP ${response.status}`, 'error');
                    console.log('qBittorrent test failed - full response:', response);
                }
            } catch (e) {
                showToast('Connected but could not get version', 'info');
                console.error('qBittorrent test error:', e);
            }
        }
    });

    GM_registerMenuCommand('🔄 Force Re-login', async () => {
        // Clear stored session
        qbitSessionId = null;
        GM_setValue('qbit_session', null);
        showToast('Session cleared, logging in...', 'info');
        const success = await qbitLogin();
        if (success) {
            showToast('Re-login successful!', 'success');
        }
    });

    GM_registerMenuCommand('📊 Show qBittorrent Web UI', () => {
        window.open(CONFIG.qbittorrent.url, '_blank');
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

        console.log('qBittorrent Torrent Interceptor loaded');
    }

    init();
})();
