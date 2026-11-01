var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
const fs = require('fs');
const path = require('path');
const os = require('os');
let ipcMain = null;
let shell = null;
// Allowlisted PHP directives that can be modified
const ALLOWED_PHP_KEYS = new Set([
    'memory_limit', 'max_input_vars', 'max_input_time',
    'post_max_size', 'upload_max_filesize',
]);
// Keys that must never appear in parsed settings objects
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const LOCAL_SITES_DIR = path.join(os.homedir(), 'Local Sites');
function isInside(child, parent) {
    return child.startsWith(parent + path.sep);
}
function realpathOrResolve(p) {
    try {
        return fs.realpathSync(p);
    }
    catch (_) {
        return path.resolve(p);
    }
}
// Validate that a path is under an expected Local Sites directory
function isValidSitePath(sitePath) {
    if (typeof sitePath !== 'string' || !sitePath)
        return false;
    const resolved = path.resolve(expandPath(sitePath));
    if (!isInside(resolved, LOCAL_SITES_DIR))
        return false;
    // Also check with symlinks resolved, so a site folder can't link outside Local Sites
    return isInside(realpathOrResolve(resolved), realpathOrResolve(LOCAL_SITES_DIR));
}
// Write a file inside a site folder without following symlinks or hard links. Site
// folders can come from imported archives, so a planted link (e.g. a backup path
// pointing at ~/.zshrc) must never redirect a write outside the site.
function safeWriteFile(filePath, content, sitePath, { createOnly = false, mode = 0o644 } = {}) {
    const siteRoot = fs.realpathSync(expandPath(sitePath));
    const parent = fs.realpathSync(path.dirname(filePath));
    if (parent !== siteRoot && !isInside(parent, siteRoot)) {
        throw new Error(`Refusing to write outside the site folder: ${filePath}`);
    }
    let st = null;
    try {
        st = fs.lstatSync(filePath);
    }
    catch (_) { }
    if (st && (!st.isFile() || st.nlink > 1)) {
        throw new Error(`Refusing to write to a link or special file: ${filePath}`);
    }
    const { O_WRONLY, O_CREAT, O_TRUNC, O_EXCL, O_NOFOLLOW = 0 } = fs.constants;
    const flags = O_WRONLY | O_CREAT | O_NOFOLLOW | (createOnly ? O_EXCL : O_TRUNC);
    const fd = fs.openSync(filePath, flags, mode);
    try {
        fs.writeFileSync(fd, content, 'utf8');
    }
    finally {
        fs.closeSync(fd);
    }
}
// Backups live in <site>/conf, outside the web root, so nginx can't serve them
// (a wp-config.php.bak in app/public leaks DB credentials and salts as plain text)
function getBackupPath(sitePath, fileName) {
    const dir = path.join(expandPath(sitePath), 'conf', 'local-debug-toolkit-backups');
    if (!fs.existsSync(dir))
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return path.join(dir, fileName);
}
// Older versions wrote backups next to wp-config.php. Move them out of the web root.
function migrateLegacyBackups(sitePath, configPath) {
    for (const suffix of ['.wpdebug.bak', '.toolkit.bak']) {
        const legacy = configPath + suffix;
        let st = null;
        try {
            st = fs.lstatSync(legacy);
        }
        catch (_) {
            continue;
        }
        try {
            const dest = getBackupPath(sitePath, 'wp-config.php' + suffix);
            if (st.isFile() && st.nlink === 1 && !fs.existsSync(dest)) {
                safeWriteFile(dest, fs.readFileSync(legacy, 'utf8'), sitePath, { createOnly: true, mode: 0o600 });
            }
        }
        catch (_) { }
        // unlink removes a symlink itself, never its target
        try {
            fs.unlinkSync(legacy);
        }
        catch (_) { }
    }
}
// Helper functions
// Accepted formats per PHP directive. Mirrors the renderer's checks, but enforced here
// because the value is written into a template that Local renders with Handlebars.
const SIZE_RE = /^\d+[KMGT]$/i;
const PHP_VALUE_VALIDATORS = {
    memory_limit: (v) => v === '-1' || SIZE_RE.test(v),
    post_max_size: (v) => SIZE_RE.test(v),
    upload_max_filesize: (v) => SIZE_RE.test(v),
    max_input_vars: (v) => /^\d+$/.test(v) && +v >= 1 && +v <= 10000,
    max_input_time: (v) => /^-?\d+$/.test(v) && +v >= -1 && +v <= 86400,
};
// Safe in-place update: only modifies allowed key=value lines, never creates files
function updatePhpIniLines(filePath, settings, sitePath) {
    if (!fs.existsSync(filePath))
        return false;
    const current = readPhpIni(filePath);
    // Filter to allowed PHP keys with valid values. Empty and unchanged values are skipped,
    // so an odd value already in the file doesn't block saving the others.
    const safeSettings = Object.create(null);
    for (const k of Object.keys(settings || {})) {
        if (!ALLOWED_PHP_KEYS.has(k) || DANGEROUS_KEYS.has(k))
            continue;
        const value = String(settings[k]).trim();
        if (value === '' || value === current[k])
            continue;
        if (!PHP_VALUE_VALIDATORS[k](value))
            throw new Error(`Invalid value for ${k}: ${value}`);
        safeSettings[k] = value;
    }
    if (Object.keys(safeSettings).length === 0)
        return false;
    const raw = fs.readFileSync(filePath, 'utf8');
    const lines = raw.split('\n');
    let changed = false;
    const updatedLines = lines.map(line => {
        const trimmed = line.trim();
        if (trimmed.startsWith(';') || trimmed === '' || !trimmed.includes('='))
            return line;
        const key = trimmed.split('=')[0].trim();
        if (key in safeSettings) {
            changed = true;
            return `${key} = ${safeSettings[key]}`;
        }
        return line;
    });
    if (changed) {
        safeWriteFile(filePath, updatedLines.join('\n'), sitePath);
    }
    return changed;
}
const WP_STOP_MARKER = "/* That's all, stop editing!";
function expandPath(sitePath) {
    if (sitePath.startsWith('~')) {
        return sitePath.replace('~', os.homedir());
    }
    return sitePath;
}
function findWpRoot(sitePath) {
    const expandedPath = expandPath(sitePath);
    const candidates = [
        path.join(expandedPath, 'app', 'public'),
        expandedPath,
    ];
    for (const p of candidates) {
        try {
            if (fs.existsSync(path.join(p, 'wp-config.php')))
                return p;
        }
        catch (_) { }
    }
    return candidates[0];
}
// The debug log lives in <site>/logs, outside the web root. WordPress's default
// (wp-content/debug.log) can be downloaded by anyone who can reach the site, e.g. via a Live Link.
function getPaths(sitePath) {
    const wpRoot = findWpRoot(sitePath);
    const configPath = path.join(wpRoot, 'wp-config.php');
    const logPath = path.join(expandPath(sitePath), 'logs', 'wp-debug.log');
    const legacyLogPath = path.join(wpRoot, 'wp-content', 'debug.log');
    // PHP expression for WP_DEBUG_LOG, relative to wp-config.php so it survives the site folder moving
    const logDefine = `__DIR__ . '/${path.relative(wpRoot, logPath).split(path.sep).join('/')}'`;
    return { wpRoot, configPath, logPath, legacyLogPath, logDefine };
}
function defineRe(name) {
    return new RegExp(`define\\(\\s*['\"]${name}['\"]\\s*,\\s*([^;]*?)\\s*\\)\\s*;`, 'i');
}
function readConfig(configPath) {
    const raw = fs.readFileSync(configPath, 'utf8');
    const readValue = (name) => {
        const m = raw.match(defineRe(name));
        return m ? m[1].trim() : null;
    };
    const readBool = (name) => (readValue(name) || '').toLowerCase() === 'true';
    // WP_DEBUG_LOG may be true or a log file path
    const logValue = readValue('WP_DEBUG_LOG');
    return {
        WP_DEBUG: readBool('WP_DEBUG'),
        WP_DEBUG_DISPLAY: readBool('WP_DEBUG_DISPLAY'),
        WP_DEBUG_LOG: logValue !== null && !['false', '0', "''", '""', 'null'].includes(logValue.toLowerCase()),
        logIsLegacy: (logValue || '').toLowerCase() === 'true',
        _raw: raw,
    };
}
// The log WordPress is currently writing to: wp-content/debug.log for sites still set to
// WP_DEBUG_LOG = true, otherwise <site>/logs/wp-debug.log
function getActiveLogPath(sitePath) {
    const { configPath, logPath, legacyLogPath } = getPaths(sitePath);
    try {
        if (readConfig(configPath).logIsLegacy)
            return legacyLogPath;
    }
    catch (_) { }
    return logPath;
}
function writeConfig(sitePath, configPath, next) {
    let raw = fs.readFileSync(configPath, 'utf8');
    migrateLegacyBackups(sitePath, configPath);
    try {
        const bakPath = getBackupPath(sitePath, 'wp-config.php.wpdebug.bak');
        if (!fs.existsSync(bakPath))
            safeWriteFile(bakPath, raw, sitePath, { createOnly: true, mode: 0o600 });
    }
    catch (_) { }
    const putDefine = (name, value) => {
        const statement = `define('${name}', ${value});`;
        const re = defineRe(name);
        if (re.test(raw)) {
            raw = raw.replace(re, () => statement);
        }
        else {
            const insert = `\n// Added by Local Add-on: Local Debug Toolkit\n${statement}\n`;
            const idx = raw.indexOf(WP_STOP_MARKER);
            raw = idx !== -1 ? raw.slice(0, idx) + insert + raw.slice(idx) : raw + insert;
        }
    };
    putDefine('WP_DEBUG', next.WP_DEBUG ? 'true' : 'false');
    putDefine('WP_DEBUG_DISPLAY', next.WP_DEBUG_DISPLAY ? 'true' : 'false');
    putDefine('WP_DEBUG_LOG', next.WP_DEBUG_LOG ? getPaths(sitePath).logDefine : 'false');
    safeWriteFile(configPath, raw, sitePath);
}
function readPhpIni(iniPath) {
    if (!fs.existsSync(iniPath))
        return {};
    const raw = fs.readFileSync(iniPath, 'utf8');
    const settings = Object.create(null);
    const lines = raw.split('\n');
    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith(';') || trimmed === '' || !trimmed.includes('='))
            continue;
        const parts = trimmed.split('=');
        if (parts.length < 2)
            continue;
        const key = parts[0].trim();
        if (DANGEROUS_KEYS.has(key))
            continue;
        const value = parts.slice(1).join('=').trim();
        settings[key] = value;
    }
    return settings;
}
function ensureFile(pth, sitePath) {
    try {
        if (!fs.existsSync(pth)) {
            fs.mkdirSync(path.dirname(pth), { recursive: true });
            safeWriteFile(pth, '', sitePath, { createOnly: true });
        }
    }
    catch (_) { }
}
// MU-plugin: in-WP-admin debug log viewer. Installed on demand via the
// "Show in WP Admin" toggle; auto-removed when WP_DEBUG_LOG is turned off.
const MU_PLUGIN_FILENAME = 'local-debug-toolkit-log-viewer.php';
function getMuPluginPath(sitePath) {
    const wpRoot = findWpRoot(sitePath);
    return path.join(wpRoot, 'wp-content', 'mu-plugins', MU_PLUGIN_FILENAME);
}
function isValidMuPluginPath(muPath, sitePath) {
    const wpRoot = findWpRoot(sitePath);
    const muDir = path.join(wpRoot, 'wp-content', 'mu-plugins');
    const resolved = path.resolve(muPath);
    return resolved === path.join(muDir, MU_PLUGIN_FILENAME);
}
function getMuPluginSource() {
    return `<?php
/**
 * Plugin Name: Local Debug Toolkit — Log Viewer
 * Description: Adds Tools → Debug Log to wp-admin. Managed by Local Debug Toolkit; toggle from Local to remove.
 * Version: 1.2.0
 * Author: Everlee Labs
 */

if (!defined('ABSPATH')) exit;

if (!function_exists('ldt_log_path')) {
  function ldt_log_path() {
    if (defined('WP_DEBUG_LOG') && is_string(WP_DEBUG_LOG)) {
      $real = realpath(WP_DEBUG_LOG);
      return $real ? $real : WP_DEBUG_LOG;
    }
    return WP_CONTENT_DIR . '/debug.log';
  }
}

// On multisite, every subsite admin has manage_options; the log covers the whole network
if (!function_exists('ldt_capability')) {
  function ldt_capability() {
    return is_multisite() ? 'manage_network_options' : 'manage_options';
  }
}

add_action('admin_menu', function () {
  add_management_page('Debug Log', 'Debug Log', ldt_capability(), 'ldt-debug-log', 'ldt_render_debug_log_page');
});

add_action('admin_bar_menu', function ($wp_admin_bar) {
  if (!is_admin_bar_showing()) return;
  if (!current_user_can(ldt_capability())) return;
  if (!defined('WP_DEBUG_LOG') || !WP_DEBUG_LOG) return;

  $wp_admin_bar->add_node([
    'id'    => 'ldt-debug-log',
    'title' => '&#x1F41E; Debug Log',
    'href'  => admin_url('tools.php?page=ldt-debug-log'),
    'meta'  => ['title' => 'View Debug Log'],
  ]);
}, 100);

add_action('admin_init', function () {
  if (!isset($_GET['page'], $_GET['ldt_action'])) return;
  if ($_GET['page'] !== 'ldt-debug-log' || $_GET['ldt_action'] !== 'download') return;
  if (!current_user_can(ldt_capability())) wp_die('Insufficient permissions');
  check_admin_referer('ldt_download_log');

  $path = ldt_log_path();
  if (!file_exists($path)) wp_die('Log file not found');

  nocache_headers();
  header('Content-Type: text/plain; charset=utf-8');
  header('Content-Disposition: attachment; filename="debug.log"');
  header('Content-Length: ' . filesize($path));
  readfile($path);
  exit;
});

function ldt_render_debug_log_page() {
  if (!current_user_can(ldt_capability())) wp_die('Insufficient permissions');

  $path = ldt_log_path();
  $tail = 500 * 1024;
  $exists = file_exists($path);
  $size = $exists ? filesize($path) : 0;
  $content = '';
  $truncated = false;

  if ($exists && $size > 0) {
    $fh = @fopen($path, 'rb');
    if ($fh) {
      if ($size > $tail) {
        fseek($fh, -$tail, SEEK_END);
        fgets($fh); // skip the partial first line
        $truncated = true;
      }
      $content = stream_get_contents($fh);
      fclose($fh);
    }
  }

  $dl = wp_nonce_url(admin_url('tools.php?page=ldt-debug-log&ldt_action=download'), 'ldt_download_log');
  $refresh = admin_url('tools.php?page=ldt-debug-log');
  ?>
  <div class="wrap">
    <h1>Debug Log</h1>
    <p>
      <code><?php echo esc_html($path); ?></code>
      <?php if ($exists): ?> &mdash; <?php echo esc_html(size_format($size)); ?><?php endif; ?>
    </p>
    <p>
      <a class="button button-primary" href="<?php echo esc_url($refresh); ?>">Refresh</a>
      <?php if ($exists && $size > 0): ?>
        <a class="button" href="<?php echo esc_url($dl); ?>">Download full log</a>
      <?php endif; ?>
    </p>
    <?php if (!$exists): ?>
      <p><em>Log file does not exist yet.</em></p>
    <?php elseif ($size === 0): ?>
      <p><em>Log file is empty.</em></p>
    <?php else: ?>
      <?php if ($truncated): ?>
        <p><em>Showing last 500&nbsp;KB of a <?php echo esc_html(size_format($size)); ?> file. <a href="<?php echo esc_url($dl); ?>">Download full log</a> for everything.</em></p>
      <?php endif; ?>
      <textarea readonly style="width:100%;height:600px;font-family:monospace;font-size:12px;white-space:pre;background:#1e1e1e;color:#d4d4d4;padding:12px;border:1px solid #ddd;"><?php echo esc_textarea($content); ?></textarea>
    <?php endif; ?>
  </div>
  <?php
}
`;
}
function installMuPlugin(sitePath) {
    const muPath = getMuPluginPath(sitePath);
    if (!isValidMuPluginPath(muPath, sitePath))
        return false;
    const muDir = path.dirname(muPath);
    if (!fs.existsSync(muDir))
        fs.mkdirSync(muDir, { recursive: true });
    safeWriteFile(muPath, getMuPluginSource(), sitePath);
    return true;
}
function removeMuPlugin(sitePath) {
    const muPath = getMuPluginPath(sitePath);
    if (!isValidMuPluginPath(muPath, sitePath))
        return false;
    if (fs.existsSync(muPath))
        fs.unlinkSync(muPath);
    return true;
}
// ── Self-update ──
const UPDATE_REPO = 'EverleeLabs/local-debug-toolkit';
const UPDATE_ASSET_RE = /^local-debug-toolkit(-v[\d.]+)?\.tar\.gz$/;
// Hosts a release download may be served from; GitHub redirects downloads to its asset CDN
const UPDATE_HOSTS = new Set(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);
const MAX_UPDATE_BYTES = 50 * 1024 * 1024;
// Resolves to the latest release JSON, or null if the repo has no releases
function fetchLatestRelease() {
    return new Promise((resolve, reject) => {
        const req = require('https').get(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, {
            headers: { 'User-Agent': 'local-debug-toolkit', 'Accept': 'application/vnd.github+json' }
        }, (res) => {
            if (res.statusCode === 404) {
                res.resume();
                resolve(null);
                return;
            }
            if (res.statusCode !== 200) {
                res.resume();
                reject(new Error(`GitHub API returned HTTP ${res.statusCode}`));
                return;
            }
            let body = '';
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => {
                try {
                    resolve(JSON.parse(body));
                }
                catch (e) {
                    reject(e);
                }
            });
        });
        req.on('error', reject);
        req.setTimeout(5000, () => { req.destroy(); reject(new Error('timeout')); });
    });
}
function findUpdateAsset(release) {
    return (release.assets || []).find((a) => UPDATE_ASSET_RE.test(a.name || ''));
}
// Simple semver comparison
function isNewerVersion(latestVersion, currentVersion) {
    const current = currentVersion.split('.').map(Number);
    const latest = latestVersion.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        if ((latest[i] || 0) > (current[i] || 0))
            return true;
        if ((latest[i] || 0) < (current[i] || 0))
            return false;
    }
    return false;
}
// ── Stale service processes ──
// If Local quits without its services exiting, orphaned nginx/php-fpm/mysqld workers keep
// holding the site's ports and sockets, and the next start retries binding them forever.
const LOCAL_SERVICES_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'Local', 'lightning-services');
const LOCAL_RUN_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'Local', 'run');
const ROUTER_PORTS = [80, 443];
const RESTART_TIMEOUT_MS = 60000;
// Resolves with stdout even on a non-zero exit (lsof exits 1 when nothing matches)
function runCommand(cmd, args) {
    const { execFile } = require('child_process');
    return new Promise((resolve) => {
        execFile(cmd, args, { timeout: 10000 }, (_err, stdout) => resolve(stdout || ''));
    });
}
// PIDs from lsof's -Fp output ("p1234" lines)
function parseLsofPids(out) {
    return out.split('\n').filter(l => l.startsWith('p')).map(l => Number(l.slice(1))).filter(Boolean);
}
function getProcessTable() {
    return __awaiter(this, void 0, void 0, function* () {
        const table = new Map();
        const out = yield runCommand('/bin/ps', ['-axo', 'pid=,ppid=,uid=,command=']);
        for (const line of out.split('\n')) {
            const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
            if (m)
                table.set(Number(m[1]), { ppid: Number(m[2]), uid: Number(m[3]), command: m[4] });
        }
        return table;
    });
}
function isDescendantOf(pid, ancestor, table) {
    for (let p = pid, hops = 0; p > 1 && hops < 50; hops++) {
        if (p === ancestor)
            return true;
        const entry = table.get(p);
        if (!entry)
            return false;
        p = entry.ppid;
    }
    return false;
}
// Worker processes rename themselves ("nginx: worker process"), so read the real binary from lsof
function getExecutablePath(pid) {
    return __awaiter(this, void 0, void 0, function* () {
        const out = yield runCommand('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'txt', '-Fn']);
        const line = out.split('\n').find(l => l.startsWith('n'));
        return line ? line.slice(1) : '';
    });
}
function getLocalSite(siteId) {
    const { getServiceContainer } = require('@getflywheel/local/main');
    return getServiceContainer().cradle.siteData.getSite(siteId);
}
// Processes outside the running Local that hold this site's ports or sockets, or the router's.
// Only leftovers of Local's own services (binaries under lightning-services, owned by this user)
// are marked killable; anything else is reported so the user can deal with it.
function findStaleProcesses(siteId) {
    return __awaiter(this, void 0, void 0, function* () {
        const site = getLocalSite(siteId);
        if (!site)
            throw new Error(`Site ${siteId} not found`);
        const resources = [];
        for (const [service, info] of Object.entries(site.services || {})) {
            for (const ports of Object.values((info && info.ports) || {})) {
                for (const port of [].concat(ports)) {
                    if (Number.isInteger(port))
                        resources.push({ label: `${service} port ${port}`, args: ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp'] });
                }
            }
        }
        for (const port of ROUTER_PORTS) {
            resources.push({ label: `router port ${port}`, args: ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp'] });
        }
        for (const [label, rel] of [['PHP socket', ['php', 'php-fpm.socket']], ['MySQL socket', ['mysql', 'mysqld.sock']]]) {
            const socketPath = path.join(LOCAL_RUN_DIR, String(siteId), ...rel);
            if (fs.existsSync(socketPath))
                resources.push({ label, args: ['-nP', '-Fp', '--', socketPath] });
        }
        const holders = new Map();
        for (const r of resources) {
            for (const pid of parseLsofPids(yield runCommand('/usr/sbin/lsof', r.args))) {
                if (!holders.has(pid))
                    holders.set(pid, new Set());
                holders.get(pid).add(r.label);
            }
        }
        const table = yield getProcessTable();
        const uid = process.getuid ? process.getuid() : -1;
        const results = [];
        for (const [pid, labels] of holders) {
            // Processes the current Local started are healthy, not stale
            if (pid === process.pid || isDescendantOf(pid, process.pid, table))
                continue;
            const entry = table.get(pid);
            const exe = yield getExecutablePath(pid);
            results.push({
                pid,
                name: exe ? path.basename(exe) : ((entry && entry.command) || 'unknown'),
                command: (entry && entry.command) || '',
                holds: Array.from(labels),
                killable: !!entry && entry.uid === uid && !!exe && isInside(exe, LOCAL_SERVICES_DIR),
            });
        }
        return results;
    });
}
function isAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (_) {
        return false;
    }
}
// Register all IPC handlers
function registerHandlers() {
    if (!ipcMain) {
        console.error('Local Debug Toolkit: Cannot register handlers - ipcMain not available');
        return;
    }
    // ── WP Debug Toggle Handlers ──
    ipcMain.handle('wpdebug:getState', (evt, { sitePath }) => {
        if (!isValidSitePath(sitePath))
            throw new Error('Invalid site path');
        try {
            const { configPath } = getPaths(sitePath);
            const cfg = readConfig(configPath);
            const muEnabled = fs.existsSync(getMuPluginPath(sitePath));
            // Keep an installed mu-plugin in step with this version's source
            if (muEnabled) {
                try {
                    if (fs.readFileSync(getMuPluginPath(sitePath), 'utf8') !== getMuPluginSource())
                        installMuPlugin(sitePath);
                }
                catch (_) { }
            }
            return {
                WP_DEBUG: cfg.WP_DEBUG,
                WP_DEBUG_DISPLAY: cfg.WP_DEBUG_DISPLAY,
                WP_DEBUG_LOG: cfg.WP_DEBUG_LOG,
                MU_PLUGIN_ENABLED: muEnabled,
                logPath: getActiveLogPath(sitePath),
            };
        }
        catch (err) {
            console.error('Local Debug Toolkit: Error in getState:', err);
            throw err;
        }
    });
    ipcMain.handle('wpdebug:setState', (evt, { sitePath, state }) => {
        if (!isValidSitePath(sitePath))
            throw new Error('Invalid site path');
        const { configPath, logPath } = getPaths(sitePath);
        writeConfig(sitePath, configPath, state);
        if (state.WP_DEBUG && state.WP_DEBUG_LOG) {
            ensureFile(logPath, sitePath);
        }
        // Auto-clean: the mu-plugin only makes sense while WP_DEBUG_LOG is on
        if (!state.WP_DEBUG_LOG) {
            try {
                removeMuPlugin(sitePath);
            }
            catch (_) { }
        }
        return true;
    });
    ipcMain.handle('wpdebug:setMuPlugin', (evt, { sitePath, enabled }) => {
        if (!isValidSitePath(sitePath))
            throw new Error('Invalid site path');
        try {
            if (enabled) {
                const ok = installMuPlugin(sitePath);
                if (!ok)
                    throw new Error('Failed to install mu-plugin');
            }
            else {
                removeMuPlugin(sitePath);
            }
            return { enabled: fs.existsSync(getMuPluginPath(sitePath)) };
        }
        catch (e) {
            throw new Error(`Failed to update mu-plugin: ${e.message}`);
        }
    });
    ipcMain.handle('wpdebug:readLog', (evt, { sitePath }) => {
        if (!isValidSitePath(sitePath))
            throw new Error('Invalid site path');
        const p = getActiveLogPath(sitePath);
        try {
            if (fs.existsSync(p))
                return fs.readFileSync(p, 'utf8');
            return '';
        }
        catch (e) {
            return `Error reading log: ${e.message}`;
        }
    });
    ipcMain.handle('wpdebug:openLog', (evt_1, _a) => __awaiter(this, [evt_1, _a], void 0, function* (evt, { sitePath }) {
        if (!isValidSitePath(sitePath))
            throw new Error('Invalid site path');
        const p = getActiveLogPath(sitePath);
        ensureFile(p, sitePath);
        try {
            if (shell) {
                yield shell.openPath(p);
            }
            return true;
        }
        catch (e) {
            return false;
        }
    }));
    ipcMain.handle('wpdebug:clearLog', (evt, { sitePath }) => {
        if (!isValidSitePath(sitePath))
            throw new Error('Invalid site path');
        const p = getActiveLogPath(sitePath);
        try {
            safeWriteFile(p, '', sitePath);
            return true;
        }
        catch (e) {
            throw new Error(`Failed to clear log: ${e.message}`);
        }
    });
    // ── WP Config Editor Handlers ──
    ipcMain.handle('wpconfig:read', (evt, { sitePath }) => {
        if (!isValidSitePath(sitePath))
            throw new Error('Invalid site path');
        try {
            const { configPath } = getPaths(sitePath);
            if (!fs.existsSync(configPath)) {
                return { content: '', exists: false, path: configPath };
            }
            const content = fs.readFileSync(configPath, 'utf8');
            return { content, exists: true, path: configPath };
        }
        catch (e) {
            throw new Error(`Failed to read wp-config.php: ${e.message}`);
        }
    });
    ipcMain.handle('wpconfig:write', (evt, { sitePath, content }) => {
        if (!isValidSitePath(sitePath))
            throw new Error('Invalid site path');
        try {
            const { configPath } = getPaths(sitePath);
            migrateLegacyBackups(sitePath, configPath);
            // Always create a backup before writing
            if (fs.existsSync(configPath)) {
                const current = fs.readFileSync(configPath, 'utf8');
                safeWriteFile(getBackupPath(sitePath, 'wp-config.php.toolkit.bak'), current, sitePath, { mode: 0o600 });
            }
            safeWriteFile(configPath, String(content), sitePath);
            return { success: true, path: configPath };
        }
        catch (e) {
            throw new Error(`Failed to write wp-config.php: ${e.message}`);
        }
    });
    ipcMain.handle('wpconfig:openInEditor', (evt_1, _a) => __awaiter(this, [evt_1, _a], void 0, function* (evt, { sitePath }) {
        if (!isValidSitePath(sitePath))
            throw new Error('Invalid site path');
        try {
            const { configPath } = getPaths(sitePath);
            if (shell) {
                yield shell.openPath(configPath);
            }
            return true;
        }
        catch (e) {
            return false;
        }
    }));
    // ── PHP Settings Handlers ──
    ipcMain.handle('phpsettings:read', (evt, { sitePath, phpVersion, siteId }) => {
        if (!isValidSitePath(sitePath))
            throw new Error('Invalid site path');
        try {
            const expanded = expandPath(sitePath);
            // Per the Local docs, edit the existing file in the site's /conf directory
            const hbsPath = path.join(expanded, 'conf', 'php', 'php.ini.hbs');
            const exists = fs.existsSync(hbsPath);
            const iniSettings = exists ? readPhpIni(hbsPath) : {};
            const settings = {};
            if (iniSettings.max_input_vars != null)
                settings.max_input_vars = iniSettings.max_input_vars;
            if (iniSettings.memory_limit != null)
                settings.memory_limit = iniSettings.memory_limit;
            if (iniSettings.post_max_size != null)
                settings.post_max_size = iniSettings.post_max_size;
            if (iniSettings.upload_max_filesize != null)
                settings.upload_max_filesize = iniSettings.upload_max_filesize;
            if (iniSettings.max_input_time != null)
                settings.max_input_time = iniSettings.max_input_time;
            return {
                settings,
                iniPath: hbsPath,
                exists,
            };
        }
        catch (e) {
            throw new Error(`Failed to read PHP settings: ${e.message}`);
        }
    });
    ipcMain.handle('phpsettings:write', (evt, { sitePath, settings, phpVersion, siteId }) => {
        if (!isValidSitePath(sitePath))
            throw new Error('Invalid site path');
        try {
            const expanded = expandPath(sitePath);
            const hbsPath = path.join(expanded, 'conf', 'php', 'php.ini.hbs');
            if (!fs.existsSync(hbsPath)) {
                throw new Error(`Config file not found: ${hbsPath}`);
            }
            // Safe in-place update — only changes matching key=value lines
            const ok = updatePhpIniLines(hbsPath, settings, sitePath);
            if (!ok) {
                throw new Error('No matching settings found to update');
            }
            return {
                success: true,
                updated: [hbsPath],
            };
        }
        catch (e) {
            throw new Error(`Failed to write PHP settings: ${e.message}`);
        }
    });
    ipcMain.handle('phpsettings:openInEditor', (evt_1, _a) => __awaiter(this, [evt_1, _a], void 0, function* (evt, { sitePath, phpVersion, siteId }) {
        if (!isValidSitePath(sitePath))
            throw new Error('Invalid site path');
        try {
            const expanded = expandPath(sitePath);
            const hbsPath = path.join(expanded, 'conf', 'php', 'php.ini.hbs');
            if (shell) {
                yield shell.openPath(hbsPath);
            }
            return true;
        }
        catch (e) {
            return false;
        }
    }));
    // ── Update Check Handler ──
    ipcMain.handle('wpdebug:checkForUpdate', () => __awaiter(this, void 0, void 0, function* () {
        try {
            const pkg = require('../package.json');
            // Dev-only: launch Local with LDT_FAKE_VERSION=1.3.0 to see the update banner
            const currentVersion = process.env.LDT_FAKE_VERSION || pkg.version;
            const release = yield fetchLatestRelease();
            if (!release)
                return { updateAvailable: false, currentVersion };
            const latestVersion = (release.tag_name || '').replace(/^v/, '');
            if (!latestVersion)
                return { updateAvailable: false, currentVersion };
            const asset = findUpdateAsset(release);
            return {
                updateAvailable: isNewerVersion(latestVersion, currentVersion),
                currentVersion,
                latestVersion,
                releaseUrl: release.html_url || '',
                releaseNotes: release.body || '',
                downloadUrl: (asset && asset.browser_download_url) || release.html_url || '',
            };
        }
        catch (e) {
            console.log('Local Debug Toolkit: Update check failed:', e.message);
            return { updateAvailable: false, error: e.message };
        }
    }));
    ipcMain.handle('wpdebug:performUpdate', () => __awaiter(this, void 0, void 0, function* () {
        // Look the release up here instead of trusting a URL passed in from the renderer
        const release = yield fetchLatestRelease();
        const asset = release && findUpdateAsset(release);
        if (!asset)
            throw new Error('No add-on archive found in the latest release');
        // GitHub computes this digest when the asset is uploaded
        const digest = /^sha256:([0-9a-f]{64})$/i.exec(asset.digest || '');
        if (!digest)
            throw new Error('Release asset has no SHA-256 digest');
        const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'local-debug-toolkit-update-'));
        const tmpFile = path.join(tmpRoot, 'update.tar.gz');
        const tmpDir = path.join(tmpRoot, 'extracted');
        const downloadFile = (url, dest) => {
            return new Promise((resolve, reject) => {
                const follow = (u, redirectsLeft) => {
                    let parsed;
                    try {
                        parsed = new URL(u);
                    }
                    catch (_) {
                        reject(new Error('Invalid download URL'));
                        return;
                    }
                    // Checked on every hop, so a redirect can't send us to another host or to plain http
                    if (parsed.protocol !== 'https:' || !UPDATE_HOSTS.has(parsed.hostname)) {
                        reject(new Error(`Refusing to download from ${parsed.protocol}//${parsed.host}`));
                        return;
                    }
                    const req = require('https').get(parsed, { headers: { 'User-Agent': 'local-debug-toolkit' } }, (res) => {
                        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                            res.resume();
                            if (redirectsLeft <= 0) {
                                reject(new Error('Too many redirects'));
                                return;
                            }
                            follow(new URL(res.headers.location, parsed).href, redirectsLeft - 1);
                            return;
                        }
                        if (res.statusCode !== 200) {
                            res.resume();
                            reject(new Error(`Download failed: HTTP ${res.statusCode}`));
                            return;
                        }
                        const hash = require('crypto').createHash('sha256');
                        let bytes = 0;
                        res.on('data', (chunk) => {
                            bytes += chunk.length;
                            if (bytes > MAX_UPDATE_BYTES)
                                req.destroy(new Error('Download too large'));
                            hash.update(chunk);
                        });
                        const out = fs.createWriteStream(dest, { flags: 'wx', mode: 0o600 });
                        res.pipe(out);
                        out.on('finish', () => out.close(() => resolve(hash.digest('hex'))));
                        out.on('error', reject);
                    });
                    req.on('error', reject);
                    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Download timed out')); });
                };
                follow(url, 5);
            });
        };
        const extractTar = (tarPath, destDir) => {
            const { execFile } = require('child_process');
            return new Promise((resolve, reject) => {
                execFile('tar', ['-xzf', tarPath, '-C', destDir], (err) => {
                    err ? reject(err) : resolve();
                });
            });
        };
        // lstat, not stat: a symlink in the archive must not pull outside files into the add-on
        const copyDir = (src, dest) => {
            if (!fs.existsSync(dest))
                fs.mkdirSync(dest, { recursive: true });
            for (const entry of fs.readdirSync(src)) {
                const s = path.join(src, entry);
                const d = path.join(dest, entry);
                const st = fs.lstatSync(s);
                if (st.isDirectory())
                    copyDir(s, d);
                else if (st.isFile())
                    fs.copyFileSync(s, d);
                else
                    throw new Error(`Unexpected non-regular file in update archive: ${entry}`);
            }
        };
        try {
            const actual = yield downloadFile(asset.browser_download_url, tmpFile);
            if (actual !== digest[1].toLowerCase())
                throw new Error('Update archive checksum mismatch');
            fs.mkdirSync(tmpDir);
            yield extractTar(tmpFile, tmpDir);
            const addonDir = path.join(os.homedir(), 'Library', 'Application Support', 'Local', 'addons', 'local-debug-toolkit');
            if (!fs.existsSync(addonDir))
                throw new Error('Addon install directory not found');
            const srcDir = path.join(tmpDir, 'local-debug-toolkit');
            if (!fs.existsSync(srcDir) || !fs.lstatSync(srcDir).isDirectory())
                throw new Error('Unexpected archive structure');
            // A symlinked add-on folder is a dev checkout; copying would overwrite the repo
            if (fs.lstatSync(addonDir).isSymbolicLink()) {
                console.log('Local Debug Toolkit: add-on folder is a symlink (dev install), skipping copy');
                return { success: true, skippedCopy: true };
            }
            copyDir(srcDir, addonDir);
            return { success: true };
        }
        finally {
            try {
                fs.rmSync(tmpRoot, { recursive: true, force: true });
            }
            catch (_) { }
        }
    }));
    // ── Restart handlers ──
    ipcMain.handle('wpdebug:restartApp', () => __awaiter(this, void 0, void 0, function* () {
        const { app } = require('electron');
        app.relaunch();
        // quit() (not exit()) so Local runs its normal shutdown and stops running sites first
        app.quit();
    }));
    ipcMain.handle('wpdebug:restartSite', (evt_1, _a) => __awaiter(this, [evt_1, _a], void 0, function* (evt, { siteId }) {
        let timer = null;
        try {
            const { getServiceContainer } = require('@getflywheel/local/main');
            const { siteProcessManager, siteData } = getServiceContainer().cradle;
            const site = siteData.getSite(siteId);
            if (!site)
                return { success: false, reason: `Site ${siteId} not found` };
            // Same call Local's own restartSite GraphQL mutation makes; it also updates the site status in the UI.
            // Local retries a blocked port forever, so stop waiting after a while and let the UI explain.
            const timeout = new Promise((resolve) => {
                timer = setTimeout(() => resolve('timeout'), RESTART_TIMEOUT_MS);
            });
            if ((yield Promise.race([siteProcessManager.restart(site), timeout])) === 'timeout') {
                return { success: false, timedOut: true, reason: `Site did not restart within ${RESTART_TIMEOUT_MS / 1000} seconds` };
            }
            return { success: true };
        }
        catch (e) {
            console.error('Local Debug Toolkit: restartSite failed:', e.message);
            return { success: false, reason: e.message };
        }
        finally {
            clearTimeout(timer);
        }
    }));
    ipcMain.handle('wpdebug:findStaleProcesses', (evt_1, _a) => __awaiter(this, [evt_1, _a], void 0, function* (evt, { siteId }) {
        try {
            return { processes: yield findStaleProcesses(siteId) };
        }
        catch (e) {
            console.error('Local Debug Toolkit: findStaleProcesses failed:', e.message);
            return { processes: [], error: e.message };
        }
    }));
    // Takes a site ID, not PIDs: the list is rebuilt here so only processes that still pass
    // the killable check are signalled
    ipcMain.handle('wpdebug:killStaleProcesses', (evt_1, _a) => __awaiter(this, [evt_1, _a], void 0, function* (evt, { siteId }) {
        const targets = (yield findStaleProcesses(siteId)).filter(p => p.killable).map(p => p.pid);
        for (const pid of targets) {
            try {
                process.kill(pid, 'SIGTERM');
            }
            catch (_) { }
        }
        // Give them a few seconds to exit cleanly, then force the rest
        for (let i = 0; i < 30 && targets.some(isAlive); i++) {
            yield new Promise(r => setTimeout(r, 100));
        }
        for (const pid of targets.filter(isAlive)) {
            try {
                process.kill(pid, 'SIGKILL');
            }
            catch (_) { }
        }
        yield new Promise(r => setTimeout(r, 200));
        const failed = targets.filter(isAlive);
        console.log(`Local Debug Toolkit: stopped stale processes ${targets.join(', ')}${failed.length ? `; still running: ${failed.join(', ')}` : ''}`);
        return { killed: targets.filter(pid => !failed.includes(pid)), failed };
    }));
    console.log('Local Debug Toolkit: All IPC handlers registered successfully');
}
// Try getting ipcMain from electron if available globally
try {
    const electron = require('electron');
    if (electron && electron.ipcMain) {
        ipcMain = electron.ipcMain;
        shell = electron.shell;
        registerHandlers();
    }
}
catch (e) {
    console.log('Local Debug Toolkit: Could not get electron directly:', e.message);
}
// Local loads add-ons with `new AddonClass(context)`, so this must be a regular
// function, not an arrow function (arrow functions can't be called with `new`)
module.exports = function (context) {
    // If handlers weren't registered yet, try from context
    if (!ipcMain && context && context.electron) {
        ipcMain = context.electron.ipcMain;
        shell = context.electron.shell;
        if (ipcMain) {
            registerHandlers();
        }
    }
};
