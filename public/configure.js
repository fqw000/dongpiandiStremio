/**
 * 懂片帝 Stremio Addon 配置页面交互
 *
 * 职责：
 *   - 收集用户配置（域名 / TMDB Key / 类型 / 开关）
 *   - 编码为 base64url
 *   - 生成 manifest URL 与 stremio:// 安装链接
 *   - 展示二维码
 *
 * 配置字段（与 src/config.js 的 buildConfig 一一对应）：
 *   bd      - 懂片帝域名
 *   tk      - TMDB API Key
 *   cats    - 启用的类型数组
 *   imdb    - 启用 IMDb 解析（false 时写入）
 *   stream  - 启用 Stream（false 时写入）
 *   debug   - 启用 debug 日志（true 时写入）
 *
 * @module configure
 */

(function () {
    'use strict';

    // ==========================================
    // 常量
    // ==========================================

    const DEFAULTS = {
        baseDomain: 'dongpian17.com',
        buildVersion: 'dongpiandi-v2026.09.30.1-dbb1f9857565-web',
        enableImdb: true,
        enableStream: true,
        enableDebug: false,
    };

    const ALL_CATEGORIES = ['movie', 'series', 'short', 'anime', 'variety', 'documentary'];

    const STREMIO_PROTOCOL = 'stremio://';

    // ==========================================
    // DOM
    // ==========================================

    const $ = (id) => document.getElementById(id);

    const el = {
        baseDomain: $('baseDomain'),
        tmdbApiKey: $('tmdbApiKey'),
        toggleTmdbKey: $('toggleTmdbKey'),
        enableImdb: $('enableImdb'),
        enableStream: $('enableStream'),
        enableDebug: $('enableDebug'),
        generateBtn: $('generateBtn'),
        resetBtn: $('resetBtn'),
        resultCard: $('resultCard'),
        manifestUrl: $('manifestUrl'),
        copyBtn: $('copyBtn'),
        installBtn: $('installBtn'),
        webInstallBtn: $('webInstallBtn'),
        configPreview: $('configPreview'),
        qrcode: $('qrcode'),
        sessionCookie: $('sessionCookie'),
        toggleCookie: $('toggleCookie'),
        blockedLines: $('blockedLines'),
        buildVersion: $('buildVersion'),
    };

    // ==========================================
    // 工具
    // ==========================================

    function getBaseUrl() {
        return window.location.origin;
    }

    /**
     * 编码为 base64url（UTF-8 安全）
     */
    function encodeConfig(config) {
        try {
            const json = JSON.stringify(config);
            const escaped = unescape(encodeURIComponent(json));
            const base64 = btoa(escaped);
            return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        } catch (err) {
            console.error('配置编码失败:', err);
            return '';
        }
    }

    /**
     * 从表单收集配置
     *
     * 原则：
     *   - 全部为默认值时不写字段（URL 保持干净）
     *   - cats 全部勾选时不写
     *   - 布尔开关只在非默认值时写入
     */
    function collectConfig() {
        const config = {};

        // 域名
        const bd = el.baseDomain.value.trim();
        if (bd && bd !== DEFAULTS.baseDomain) config.bd = bd;

        // TMDB Key
        const tk = el.tmdbApiKey.value.trim();
        if (tk) config.tk = tk;

        // 线路黑名单（textarea 按行分割）
        const blockedText = el.blockedLines.value.trim();
        if (blockedText) {
            const blocked = blockedText
                .split('\n')
                .map(s => s.trim())
                .filter(Boolean);
            if (blocked.length > 0) config.blockedLines = blocked;
        }

        // Build Version
        const bv = el.buildVersion.value.trim();
        if (bv && bv !== DEFAULTS.buildVersion) config.bv = bv;

        // Cookie
        const cookie = el.sessionCookie.value.trim();
        if (cookie) config.cookie = cookie;

        // 类型
        const cats = Array.from(document.querySelectorAll('.category-cb:checked'))
            .map(cb => cb.value);
        if (cats.length > 0 && cats.length < ALL_CATEGORIES.length) {
            config.cats = cats;
        } else if (cats.length === 0) {
            // 一个都没勾 → 强制至少 movie，避免完全不可用
            config.cats = ['movie'];
        }

        // 开关
        if (!el.enableImdb.checked) config.imdb = false;
        if (!el.enableStream.checked) config.stream = false;
        if (el.enableDebug.checked) config.debug = true;

        return config;
    }

    function buildUrls(config) {
        const base = getBaseUrl();
        const hasConfig = Object.keys(config).length > 0;

        let manifestUrl = `${base}/manifest.json`;
        if (hasConfig) {
            manifestUrl += `?cfg=${encodeConfig(config)}`;
        }

        const hostAndPath = manifestUrl.replace(/^https?:\/\//, '');
        const stremioUrl = `${STREMIO_PROTOCOL}${hostAndPath}`;

        return { manifestUrl, stremioUrl, hasConfig };
    }

    // ==========================================
    // Toast
    // ==========================================

    let toastTimer = null;

    function showToast(message, type = 'info') {
        let toast = document.querySelector('.toast');
        if (!toast) {
            toast = document.createElement('div');
            toast.className = 'toast';
            document.body.appendChild(toast);
        }
        toast.textContent = message;
        toast.className = `toast ${type}`;
        void toast.offsetWidth;
        toast.classList.add('show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => toast.classList.remove('show'), 2000);
    }

    // ==========================================
    // 二维码
    // ==========================================

    function updateQRCode(url) {
        el.qrcode.innerHTML = '';
        if (typeof QRCode === 'undefined') {
            el.qrcode.textContent = '二维码库加载失败';
            return;
        }
        try {
            new QRCode(el.qrcode, {
                text: url,
                width: 180,
                height: 180,
                colorDark: '#000000',
                colorLight: '#ffffff',
                correctLevel: QRCode.CorrectLevel.M,
            });
        } catch (err) {
            console.error('二维码生成失败:', err);
            el.qrcode.textContent = '二维码生成失败';
        }
    }

    // ==========================================
    // 核心
    // ==========================================

    function generate() {
        const config = collectConfig();
        const urls = buildUrls(config);

        el.manifestUrl.value = urls.manifestUrl;
        el.installBtn.href = urls.stremioUrl;

        el.configPreview.textContent = JSON.stringify(
            {
                config: Object.keys(config).length === 0 ? '(默认配置)' : config,
                manifest: urls.manifestUrl,
                stremio: urls.stremioUrl,
            },
            null,
            2
        );

        updateQRCode(urls.manifestUrl);
        el.resultCard.classList.add('show');

        setTimeout(() => {
            el.resultCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 100);
    }

    function reset() {
        el.baseDomain.value = '';
        el.tmdbApiKey.value = '';
        el.tmdbApiKey.type = 'password';
        el.sessionCookie.value = '';
        el.sessionCookie.type = 'password';
        el.enableImdb.checked = DEFAULTS.enableImdb;
        el.enableStream.checked = DEFAULTS.enableStream;
        el.enableDebug.checked = DEFAULTS.enableDebug;
        el.blockedLines.value = '';
        el.buildVersion.value = '';

        document.querySelectorAll('.category-cb').forEach(cb => {
            cb.checked = true;
        });

        el.resultCard.classList.remove('show');
        showToast('已重置为默认配置');
    }

    function copyUrl() {
        const url = el.manifestUrl.value;
        if (!url) return;

        const doCopy = () => {
            if (navigator.clipboard && window.isSecureContext) {
                return navigator.clipboard.writeText(url);
            }
            el.manifestUrl.select();
            el.manifestUrl.setSelectionRange(0, 99999);
            document.execCommand('copy');
            return Promise.resolve();
        };

        doCopy()
            .then(() => showToast('✅ 已复制到剪贴板', 'success'))
            .catch((err) => {
                console.error('复制失败:', err);
                showToast('复制失败，请手动选择', 'error');
            });
    }

    function webInstall() {
        const url = el.manifestUrl.value;
        if (!url) return;
        const encoded = encodeURIComponent(url);
        window.open(`https://web.stremio.com/#/addons?addon=${encoded}`, '_blank');
    }

    function toggleTmdbKey() {
        el.tmdbApiKey.type = el.tmdbApiKey.type === 'password' ? 'text' : 'password';
    }

    // ==========================================
    // 事件绑定
    // ==========================================

    el.generateBtn.addEventListener('click', generate);
    el.resetBtn.addEventListener('click', reset);
    el.copyBtn.addEventListener('click', copyUrl);
    el.webInstallBtn.addEventListener('click', webInstall);
    el.toggleTmdbKey.addEventListener('click', toggleTmdbKey);

    el.toggleCookie.addEventListener('click', () => {
        el.sessionCookie.type = el.sessionCookie.type === 'password' ? 'text' : 'password';
    });


    // 输入变化自动更新（如果结果卡片已显示）
    const autoUpdateInputs = [
        el.baseDomain, el.tmdbApiKey, el.sessionCookie,
        el.blockedLines, el.buildVersion,
        el.enableImdb, el.enableStream, el.enableDebug,
    ].filter(Boolean);

    autoUpdateInputs.forEach(input => {
        input.addEventListener('change', () => {
            if (el.resultCard.classList.contains('show')) generate();
        });
    });

    document.querySelectorAll('.category-cb').forEach(cb => {
        cb.addEventListener('change', () => {
            if (el.resultCard.classList.contains('show')) generate();
        });
    });

    // 回车快捷生成
    [el.baseDomain, el.tmdbApiKey, el.sessionCookie, el.buildVersion].filter(Boolean).forEach(input => {
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') generate();
        });
    });

    // ==========================================
    // 初始化
    // ==========================================

    window.addEventListener('DOMContentLoaded', () => {
        const params = new URLSearchParams(location.search);

        // 预填配置（?prefill=<base64url>）
        const prefill = params.get('prefill');
        if (prefill) {
            try {
                const json = decodeURIComponent(escape(atob(
                    prefill.replace(/-/g, '+').replace(/_/g, '/')
                )));
                const config = JSON.parse(json);

                if (config.bd) el.baseDomain.value = config.bd;
                if (config.tk) el.tmdbApiKey.value = config.tk;
                if (config.cookie) el.sessionCookie.value = config.cookie;
                if (config.imdb === false) el.enableImdb.checked = false;
                if (config.stream === false) el.enableStream.checked = false;
                if (config.debug === true) el.enableDebug.checked = true;
                if (Array.isArray(config.cats)) {
                    document.querySelectorAll('.category-cb').forEach(cb => {
                        cb.checked = config.cats.includes(cb.value);
                    });
                }
                if (Array.isArray(config.blockedLines)) {
                    el.blockedLines.value = config.blockedLines.join('\n');
                }
                if (config.bv) el.buildVersion.value = config.bv;

            } catch (err) {
                console.warn('预填配置解析失败:', err);
            }
        }

        // ?autogen=1 自动生成
        if (params.has('autogen')) generate();
    });
})();