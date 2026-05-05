
const fs = require('fs');
const path = require('path');
const os = require('os');

let ipcMain: any = null;
let shell: any = null;
let serviceContainer: any = null;

// Allowlisted PHP directives that can be modified
const ALLOWED_PHP_KEYS = new Set([
  'memory_limit', 'max_input_vars', 'max_input_time',
  'post_max_size', 'upload_max_filesize',
]);

// Keys that must never appear in parsed settings objects
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// Validate that a path is under an expected Local Sites directory
function isValidSitePath(sitePath: string): boolean {
  const expanded = expandPath(sitePath);
  const localSitesDir = path.join(os.homedir(), 'Local Sites');
  const resolved = path.resolve(expanded);
  return resolved.startsWith(localSitesDir + path.sep);
}

// Validate that a log path is within a site's wp-content directory
function isValidLogPath(logPath: string, sitePath: string): boolean {
  const wpRoot = findWpRoot(sitePath);
  const resolved = path.resolve(logPath);
  const wpContent = path.join(wpRoot, 'wp-content');
  return resolved.startsWith(wpContent + path.sep);
}

// Helper functions

function getRuntimePhpIni(siteId: string): string {
  const home = os.homedir();
  return path.join(home, 'Library', 'Application Support', 'Local', 'run', siteId, 'conf', 'php', 'php.ini');
}

// Safe in-place update: only modifies allowed key=value lines, never creates files
function updatePhpIniLines(filePath: string, settings: { [key: string]: string }): boolean {
  if (!fs.existsSync(filePath)) return false;
  // Filter to only allowed PHP keys, strip newlines from values to prevent injection
  const safeSettings: any = Object.create(null);
  for (const k of Object.keys(settings)) {
    if (ALLOWED_PHP_KEYS.has(k) && !DANGEROUS_KEYS.has(k)) {
      safeSettings[k] = String(settings[k]).replace(/[\r\n]/g, '');
    }
  }
  if (Object.keys(safeSettings).length === 0) return false;

  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split('\n');
  let changed = false;

  const updatedLines = lines.map(line => {
    const trimmed = line.trim();
    if (trimmed.startsWith(';') || trimmed === '' || !trimmed.includes('=')) return line;
    const key = trimmed.split('=')[0].trim();
    if (key in safeSettings) {
      changed = true;
      return `${key} = ${safeSettings[key]}`;
    }
    return line;
  });

  if (changed) {
    fs.writeFileSync(filePath, updatedLines.join('\n'), 'utf8');
  }
  return changed;
}
const WP_STOP_MARKER = "/* That's all, stop editing!";

function expandPath(sitePath: string): string {
  if (sitePath.startsWith('~')) {
    return sitePath.replace('~', os.homedir());
  }
  return sitePath;
}

function findWpRoot(sitePath: string): string {
  const expandedPath = expandPath(sitePath);
  const candidates = [
    path.join(expandedPath, 'app', 'public'),
    expandedPath,
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(path.join(p, 'wp-config.php'))) return p;
    } catch (_) {}
  }
  return candidates[0];
}

function getPaths(sitePath: string) {
  const wpRoot = findWpRoot(sitePath);
  const configPath = path.join(wpRoot, 'wp-config.php');
  const defaultLogPath = path.join(wpRoot, 'wp-content', 'debug.log');
  return { wpRoot, configPath, defaultLogPath };
}

function readConfig(configPath: string) {
  const raw = fs.readFileSync(configPath, 'utf8');
  const readBool = (name: string) => {
    const re = new RegExp(`define\\(\\s*['\"]${name}['\"]\\s*,\\s*(true|false)\\s*\\)\\s*;`, 'i');
    const m = raw.match(re);
    return m ? m[1].toLowerCase() === 'true' : false;
  };
  return {
    WP_DEBUG: readBool('WP_DEBUG'),
    WP_DEBUG_DISPLAY: readBool('WP_DEBUG_DISPLAY'),
    WP_DEBUG_LOG: readBool('WP_DEBUG_LOG'),
    _raw: raw,
  };
}

function writeConfig(configPath: string, next: any) {
  let raw = fs.readFileSync(configPath, 'utf8');
  const bakPath = configPath + '.wpdebug.bak';
  try {
    if (!fs.existsSync(bakPath)) fs.writeFileSync(bakPath, raw, 'utf8');
  } catch (_) {}

  const putBool = (name: string, val: boolean) => {
    const defRe = new RegExp(`define\\(\\s*['\"]${name}['\"]\\s*,\\s*(true|false)\\s*\\)\\s*;`, 'i');
    if (defRe.test(raw)) {
      raw = raw.replace(defRe, `define('${name}', ${val ? 'true' : 'false'});`);
    } else {
      const insert = `\n// Added by Local Add-on: Local Debug Toolkit\n` +
        `define('${name}', ${val ? 'true' : 'false'});\n`;
      const idx = raw.indexOf(WP_STOP_MARKER);
      raw = idx !== -1 ? raw.slice(0, idx) + insert + raw.slice(idx) : raw + insert;
    }
  };

  putBool('WP_DEBUG', !!next.WP_DEBUG);
  putBool('WP_DEBUG_DISPLAY', !!next.WP_DEBUG_DISPLAY);
  putBool('WP_DEBUG_LOG', !!next.WP_DEBUG_LOG);

  fs.writeFileSync(configPath, raw, 'utf8');
}

function readPhpIni(iniPath: string) {
  if (!fs.existsSync(iniPath)) return {};
  const raw = fs.readFileSync(iniPath, 'utf8');
  const settings: any = Object.create(null);
  const lines = raw.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith(';') || trimmed === '' || !trimmed.includes('=')) continue;
    const parts = trimmed.split('=');
    if (parts.length < 2) continue;
    const key = parts[0].trim();
    if (DANGEROUS_KEYS.has(key)) continue;
    const value = parts.slice(1).join('=').trim();
    settings[key] = value;
  }
  return settings;
}

function readHtaccessSettings(filePath: string) {
  if (!fs.existsSync(filePath)) return {};
  const raw = fs.readFileSync(filePath, 'utf8');
  const settings: any = {};
  const lines = raw.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || trimmed === '') continue;
    const maxInputMatch = trimmed.match(/^php_value\s+max_input_vars\s+(\d+)/i);
    if (maxInputMatch) {
      settings.max_input_vars = maxInputMatch[1];
    }
    const memLimitMatch = trimmed.match(/^php_value\s+memory_limit\s+(.+)/i);
    if (memLimitMatch) {
      settings.memory_limit = memLimitMatch[1].trim();
    }
  }
  return settings;
}

function writeHtaccessSettings(filePath: string, settings: any) {
  if (!fs.existsSync(filePath)) return false;
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split('\n');
  const updatedLines: string[] = [];
  const processed = new Set<string>();

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.match(/^php_value\s+max_input_vars\s+/i) && settings.max_input_vars !== undefined) {
      updatedLines.push(`php_value max_input_vars ${settings.max_input_vars}`);
      processed.add('max_input_vars');
      continue;
    }
    if (trimmed.match(/^php_value\s+memory_limit\s+/i) && settings.memory_limit !== undefined) {
      updatedLines.push(`php_value memory_limit ${settings.memory_limit}`);
      processed.add('memory_limit');
      continue;
    }
    updatedLines.push(line);
  }

  if (settings.max_input_vars !== undefined && !processed.has('max_input_vars')) {
    updatedLines.push(`php_value max_input_vars ${settings.max_input_vars}`);
  }
  if (settings.memory_limit !== undefined && !processed.has('memory_limit')) {
    updatedLines.push(`php_value memory_limit ${settings.memory_limit}`);
  }

  fs.writeFileSync(filePath, updatedLines.join('\n'), 'utf8');
  return true;
}

function writePhpIni(iniPath: string, settings: any, options: { allowTemplateUpdate?: boolean } = {}) {
  const { allowTemplateUpdate = true } = options;

  let raw = '';
  if (fs.existsSync(iniPath)) {
    raw = fs.readFileSync(iniPath, 'utf8');
  } else {
    // Create a basic php.ini structure if file doesn't exist
    raw = `; PHP Configuration
; Generated by Local Debug Toolkit

`;
  }
  // Create backup
  const bakPath = iniPath + '.toolkit.bak';
  try {
    if (!fs.existsSync(bakPath)) fs.writeFileSync(bakPath, raw, 'utf8');
  } catch (_) {}

  // Update settings
  const lines = raw.split('\n');
  const updatedLines: string[] = [];
  const processedKeys = new Set();

  for (const line of lines) {
    const trimmed = line.trim();

    // If this file is a template, avoid overwriting lines that contain Handlebars markers.
    // Rewriting those lines can break Local's template parsing and prevent the site from starting.
    if (!allowTemplateUpdate && (trimmed.includes('{{') || trimmed.includes('}}'))) {
      updatedLines.push(line);
      continue;
    }

    if (trimmed.startsWith(';') || trimmed === '' || !trimmed.includes('=')) {
      updatedLines.push(line);
      continue;
    }
    const parts = trimmed.split('=');
    if (parts.length < 2) {
      updatedLines.push(line);
      continue;
    }
    const key = parts[0].trim();
    if (settings.hasOwnProperty(key)) {
      updatedLines.push(`${key} = ${settings[key]}`);
      processedKeys.add(key);
    } else {
      updatedLines.push(line);
    }
  }

  // Add new settings at the end
  if (Object.keys(settings).some(key => !processedKeys.has(key))) {
    updatedLines.push('');
    updatedLines.push('; Added by Local Debug Toolkit');
    for (const [key, value] of Object.entries(settings)) {
      if (!processedKeys.has(key)) {
        updatedLines.push(`${key} = ${value}`);
      }
    }
  }

  fs.writeFileSync(iniPath, updatedLines.join('\n'), 'utf8');
}

function findPhpIni(sitePath: string, phpVersion?: string): string {
  const expandedPath = expandPath(sitePath);

  // If we know the PHP version, prefer the version-specific config first.
  // Local uses version-specific directories like conf/php-7.3.5/php.ini.hbs.
  if (phpVersion) {
    const versionCandidates = [
      path.join(expandedPath, 'conf', `php-${phpVersion}`, 'php.ini'),
      path.join(expandedPath, 'conf', `php-${phpVersion}`, 'php.ini.hbs'),
    ];
    for (const p of versionCandidates) {
      try {
        if (fs.existsSync(p)) return p;
      } catch (_) {}
    }
  }

  // Fall back to generic locations, then .hbs templates
  const candidates = [
    path.join(expandedPath, 'conf', 'php', 'php.ini'),
    path.join(expandedPath, 'conf', 'php.ini'),
    path.join(expandedPath, 'php.ini'),
    path.join(expandedPath, 'app', 'conf', 'php', 'php.ini'),
    path.join(expandedPath, 'app', 'conf', 'php.ini'),
    path.join(expandedPath, '.conf', 'php', 'php.ini'),
    path.join(expandedPath, 'docker', 'php', 'php.ini'),
    path.join(expandedPath, 'conf', 'php', 'php.ini.hbs'),
    path.join(expandedPath, 'conf', 'php.ini.hbs'),
    path.join(expandedPath, 'app', 'conf', 'php', 'php.ini.hbs'),
    path.join(expandedPath, 'app', 'conf', 'php.ini.hbs'),
  ];

  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch (_) {}
  }

  // Default to conf/php/php.ini
  return path.join(expandedPath, 'conf', 'php', 'php.ini');
}

function findPhpIniVariants(sitePath: string): string[] {
  const expandedPath = expandPath(sitePath);
  const results: string[] = [];

  const roots = [
    path.join(expandedPath, 'conf'),
    path.join(expandedPath, 'app', 'conf'),
  ];

  for (const root of roots) {
    try {
      if (!fs.existsSync(root)) continue;
      const entries = fs.readdirSync(root);
      // Look for php.ini in known places and in any php-* subdirectories.
      const candidates = [
        path.join(root, 'php.ini'),
        path.join(root, 'php', 'php.ini'),
      ];

      for (const c of candidates) {
        if (fs.existsSync(c)) results.push(c);
      }

      for (const entry of entries) {
        const entryPath = path.join(root, entry);
        if (!fs.statSync(entryPath).isDirectory()) continue;
        const phpIniPath = path.join(entryPath, 'php.ini');
        if (fs.existsSync(phpIniPath)) {
          results.push(phpIniPath);
        }
      }
    } catch (_) {
      // ignore
    }
  }

  return Array.from(new Set(results));
}

function findPhpIniHbsTemplates(sitePath: string): string[] {
  const expandedPath = expandPath(sitePath);
  const results: string[] = [];
  const roots = [
    path.join(expandedPath, 'conf'),
    path.join(expandedPath, 'app', 'conf'),
  ];

  for (const root of roots) {
    try {
      if (!fs.existsSync(root)) continue;

      // Top-level template file (e.g. conf/php.ini.hbs)
      const topLevel = path.join(root, 'php.ini.hbs');
      if (fs.existsSync(topLevel)) results.push(topLevel);

      const entries = fs.readdirSync(root);
      for (const entry of entries) {
        const candidate = path.join(root, entry, 'php.ini.hbs');
        if (fs.existsSync(candidate)) {
          results.push(candidate);
        }
      }
    } catch (_) {
      // ignore
    }
  }

  return Array.from(new Set(results));
}

function scanPhpConfigFiles(sitePath: string): Array<{ path: string; type: string; max_input_vars?: string; memory_limit?: string; }> {
  const expandedPath = expandPath(sitePath);
  const results: Array<{ path: string; type: string; max_input_vars?: string; memory_limit?: string; }> = [];

  const candidates = [
    findPhpIni(sitePath),
    ...findPhpIniVariants(sitePath),
    path.join(expandedPath, '.user.ini'),
    path.join(expandedPath, 'app', '.user.ini'),
    path.join(expandedPath, 'public', '.user.ini'),
    path.join(expandedPath, 'app', 'public', '.user.ini'),
    path.join(expandedPath, '.htaccess'),
    path.join(expandedPath, 'app', '.htaccess'),
    path.join(expandedPath, 'public', '.htaccess'),
    path.join(expandedPath, 'app', 'public', '.htaccess'),
    // Local by Flywheel templates (scan for any php.ini.hbs under conf/ directories)
    ...findPhpIniHbsTemplates(sitePath),
  ];

  const uniquePaths = Array.from(new Set(candidates));

  for (const p of uniquePaths) {
    try {
      if (!fs.existsSync(p)) continue;
      const lower = p.toLowerCase();
      let scan: any = {};
      if (lower.endsWith('php.ini') || lower.endsWith('.ini') || lower.endsWith('.hbs')) {
        scan = readPhpIni(p);
      } else if (lower.endsWith('.user.ini') || lower.endsWith('.htaccess')) {
        scan = readHtaccessSettings(p);
      }

      results.push({
        path: p,
        type: lower.endsWith('.htaccess') ? 'htaccess' : lower.endsWith('.user.ini') ? 'user_ini' : lower.endsWith('.hbs') ? 'hbs' : 'php_ini',
        max_input_vars: scan.max_input_vars,
        memory_limit: scan.memory_limit,
      });
    } catch (_) {
      // ignore
    }
  }

  return results;
}

function updatePhpConfigFile(filePath: string, settings: any): boolean {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.ini') || lower.endsWith('.hbs')) {
    const current = readPhpIni(filePath);
    const merged = { ...current, ...settings };
    // When updating template files (.hbs), avoid rewriting Handlebars blocks.
    const allowTemplateUpdate = !lower.endsWith('.hbs');
    writePhpIni(filePath, merged, { allowTemplateUpdate });
    return true;
  }

  if (lower.endsWith('.user.ini') || lower.endsWith('.htaccess')) {
    return writeHtaccessSettings(filePath, settings);
  }

  return false;
}

function findEnvFile(sitePath: string): string | null {
  const expandedPath = expandPath(sitePath);
  const candidates = [
    path.join(expandedPath, '.env'),
    path.join(expandedPath, '.env.local'),
    path.join(expandedPath, 'app', '.env'),
    path.join(expandedPath, '.conf', '.env'),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch (_) {}
  }
  return null;
}

function readEnvFile(sitePath: string): any {
  const envPath = findEnvFile(sitePath);
  if (!envPath) return {};

  try {
    const content = fs.readFileSync(envPath, 'utf8');
    const envVars: any = {};
    const lines = content.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('#') || trimmed === '' || !trimmed.includes('=')) continue;
      const [key, ...valueParts] = trimmed.split('=');
      const value = valueParts.join('=').trim();
      envVars[key.trim()] = value;
    }

    return envVars;
  } catch (e) {
    return {};
  }
}

function writeEnvFile(sitePath: string, settings: any): boolean {
  const envPath = findEnvFile(sitePath);
  if (!envPath) return false;

  try {
    let content = '';
    if (fs.existsSync(envPath)) {
      content = fs.readFileSync(envPath, 'utf8');
    }

    // Create backup
    const bakPath = envPath + '.toolkit.bak';
    if (!fs.existsSync(bakPath)) {
      fs.writeFileSync(bakPath, content, 'utf8');
    }

    const lines = content.split('\n');
    const updatedLines: string[] = [];
    const processedKeys = new Set();

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('#') || trimmed === '' || !trimmed.includes('=')) {
        updatedLines.push(line);
        continue;
      }
      const [key] = trimmed.split('=');
      const cleanKey = key.trim();
      if (settings.hasOwnProperty(cleanKey)) {
        updatedLines.push(`${cleanKey}=${settings[cleanKey]}`);
        processedKeys.add(cleanKey);
      } else {
        updatedLines.push(line);
      }
    }

    // Add new settings
    for (const [key, value] of Object.entries(settings)) {
      if (!processedKeys.has(key)) {
        updatedLines.push(`${key}=${value}`);
      }
    }

    fs.writeFileSync(envPath, updatedLines.join('\n'), 'utf8');
    return true;
  } catch (e) {
    return false;
  }
}

function findLocalConfig(sitePath: string): string | null {
  const expandedPath = expandPath(sitePath);
  const candidates = [
    path.join(expandedPath, '.local', 'config.json'),
    path.join(expandedPath, 'local-config.json'),
    path.join(expandedPath, '.conf', 'local.json'),
    path.join(expandedPath, 'app', '.local', 'config.json'),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch (_) {}
  }
  return null;
}

function readLocalConfig(sitePath: string): any {
  const configPath = findLocalConfig(sitePath);
  if (!configPath) return {};

  try {
    const content = fs.readFileSync(configPath, 'utf8');
    const config = JSON.parse(content);
    return config.php || {};
  } catch (e) {
    return {};
  }
}

function writeLocalConfig(sitePath: string, settings: any): boolean {
  const configPath = findLocalConfig(sitePath);
  if (!configPath) return false;

  try {
    let config: any = {};
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, 'utf8');
      config = JSON.parse(content);
    }

    // Create backup
    const bakPath = configPath + '.toolkit.bak';
    if (!fs.existsSync(bakPath)) {
      fs.writeFileSync(bakPath, JSON.stringify(config, null, 2), 'utf8');
    }

    // Update PHP settings
    if (!config.php) config.php = {};
    Object.assign(config.php, settings);

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
    return true;
  } catch (e) {
    return false;
  }
}

function findDockerCompose(sitePath: string): string | null {
  const expandedPath = expandPath(sitePath);
  const candidates = [
    path.join(expandedPath, 'docker-compose.yml'),
    path.join(expandedPath, 'docker-compose.yaml'),
    path.join(expandedPath, '.conf', 'docker-compose.yml'),
    path.join(expandedPath, '.conf', 'docker-compose.yaml'),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch (_) {}
  }
  return null;
}

function readDockerEnv(sitePath: string): any {
  const composePath = findDockerCompose(sitePath);
  if (!composePath) return {};

  try {
    const content = fs.readFileSync(composePath, 'utf8');
    const envVars: any = {};

    // Look for environment variables in docker-compose.yml
    const envRegex = /PHP_MAX_INPUT_VARS:\s*(\d+)/g;
    let match;
    while ((match = envRegex.exec(content)) !== null) {
      envVars.max_input_vars = match[1];
    }

    const memRegex = /PHP_MEMORY_LIMIT:\s*([^'\s]+)/g;
    while ((match = memRegex.exec(content)) !== null) {
      envVars.memory_limit = match[1];
    }

    return envVars;
  } catch (e) {
    return {};
  }
}

function writeDockerEnv(sitePath: string, settings: any): boolean {
  const composePath = findDockerCompose(sitePath);
  if (!composePath) return false;

  try {
    let content = fs.readFileSync(composePath, 'utf8');
    const bakPath = composePath + '.toolkit.bak';

    // Create backup
    if (!fs.existsSync(bakPath)) {
      fs.writeFileSync(bakPath, content, 'utf8');
    }

    // Update PHP_MAX_INPUT_VARS
    if (settings.max_input_vars !== undefined) {
      const maxInputRegex = /(PHP_MAX_INPUT_VARS:\s*)\d+/g;
      if (maxInputRegex.test(content)) {
        content = content.replace(maxInputRegex, `$1${settings.max_input_vars}`);
      } else {
        // Add it to the environment section
        const envSectionRegex = /(environment:[\s\S]*?)(\n\s*[a-z]|\n\s*$)/;
        const envMatch = envSectionRegex.exec(content);
        if (envMatch) {
          const envBlock = envMatch[1];
          const insertPoint = envBlock.lastIndexOf('\n') + envBlock.length;
          content = content.slice(0, insertPoint) + `\n      PHP_MAX_INPUT_VARS: ${settings.max_input_vars}` + content.slice(insertPoint);
        }
      }
    }

    // Update PHP_MEMORY_LIMIT
    if (settings.memory_limit !== undefined) {
      const memLimitRegex = /(PHP_MEMORY_LIMIT:\s*)[^'\s]+/g;
      if (memLimitRegex.test(content)) {
        content = content.replace(memLimitRegex, `$1${settings.memory_limit}`);
      } else {
        // Add it to the environment section
        const envSectionRegex = /(environment:[\s\S]*?)(\n\s*[a-z]|\n\s*$)/;
        const envMatch = envSectionRegex.exec(content);
        if (envMatch) {
          const envBlock = envMatch[1];
          const insertPoint = envBlock.lastIndexOf('\n') + envBlock.length;
          content = content.slice(0, insertPoint) + `\n      PHP_MEMORY_LIMIT: ${settings.memory_limit}` + content.slice(insertPoint);
        }
      }
    }

    fs.writeFileSync(composePath, content, 'utf8');
    return true;
  } catch (e) {
    return false;
  }
}

function ensureFile(pth: string) {
  try {
    if (!fs.existsSync(pth)) fs.writeFileSync(pth, '', 'utf8');
  } catch (_) {}
}

// MU-plugin: in-WP-admin debug log viewer. Installed on demand via the
// "Show in WP Admin" toggle; auto-removed when WP_DEBUG_LOG is turned off.
const MU_PLUGIN_FILENAME = 'local-debug-toolkit-log-viewer.php';

function getMuPluginPath(sitePath: string): string {
  const wpRoot = findWpRoot(sitePath);
  return path.join(wpRoot, 'wp-content', 'mu-plugins', MU_PLUGIN_FILENAME);
}

function isValidMuPluginPath(muPath: string, sitePath: string): boolean {
  const wpRoot = findWpRoot(sitePath);
  const muDir = path.join(wpRoot, 'wp-content', 'mu-plugins');
  const resolved = path.resolve(muPath);
  return resolved === path.join(muDir, MU_PLUGIN_FILENAME);
}

function getMuPluginSource(): string {
  return `<?php
/**
 * Plugin Name: Local Debug Toolkit — Log Viewer
 * Description: Adds Tools → Debug Log to wp-admin. Managed by Local Debug Toolkit; toggle from Local to remove.
 * Version: 1.1.0
 * Author: Everlee Labs
 */

if (!defined('ABSPATH')) exit;

if (!function_exists('ldt_log_path')) {
  function ldt_log_path() {
    if (defined('WP_DEBUG_LOG') && is_string(WP_DEBUG_LOG)) return WP_DEBUG_LOG;
    return WP_CONTENT_DIR . '/debug.log';
  }
}

add_action('admin_menu', function () {
  add_management_page('Debug Log', 'Debug Log', 'manage_options', 'ldt-debug-log', 'ldt_render_debug_log_page');
});

add_action('admin_bar_menu', function ($wp_admin_bar) {
  if (!is_admin_bar_showing()) return;
  if (!current_user_can('manage_options')) return;
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
  if (!current_user_can('manage_options')) wp_die('Insufficient permissions');
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
  if (!current_user_can('manage_options')) wp_die('Insufficient permissions');

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

function installMuPlugin(sitePath: string): boolean {
  const muPath = getMuPluginPath(sitePath);
  if (!isValidMuPluginPath(muPath, sitePath)) return false;
  const muDir = path.dirname(muPath);
  if (!fs.existsSync(muDir)) fs.mkdirSync(muDir, { recursive: true });
  fs.writeFileSync(muPath, getMuPluginSource(), 'utf8');
  return true;
}

function removeMuPlugin(sitePath: string): boolean {
  const muPath = getMuPluginPath(sitePath);
  if (!isValidMuPluginPath(muPath, sitePath)) return false;
  if (fs.existsSync(muPath)) fs.unlinkSync(muPath);
  return true;
}

// Register all IPC handlers
function registerHandlers() {
  if (!ipcMain) {
    console.error('Local Debug Toolkit: Cannot register handlers - ipcMain not available');
    return;
  }

  // ── WP Debug Toggle Handlers ──

  ipcMain.handle('wpdebug:getState', (evt: any, { sitePath }: any) => {
    if (!isValidSitePath(sitePath)) throw new Error('Invalid site path');
    try {
      const { configPath, defaultLogPath } = getPaths(sitePath);
      const cfg = readConfig(configPath);
      return {
        WP_DEBUG: cfg.WP_DEBUG,
        WP_DEBUG_DISPLAY: cfg.WP_DEBUG_DISPLAY,
        WP_DEBUG_LOG: cfg.WP_DEBUG_LOG,
        MU_PLUGIN_ENABLED: fs.existsSync(getMuPluginPath(sitePath)),
        logPath: defaultLogPath,
      };
    } catch (err: any) {
      console.error('Local Debug Toolkit: Error in getState:', err);
      throw err;
    }
  });

  ipcMain.handle('wpdebug:setState', (evt: any, { sitePath, state }: any) => {
    if (!isValidSitePath(sitePath)) throw new Error('Invalid site path');
    const { configPath, defaultLogPath } = getPaths(sitePath);
    writeConfig(configPath, state);
    if (state.WP_DEBUG && state.WP_DEBUG_LOG) {
      ensureFile(defaultLogPath);
    }
    // Auto-clean: the mu-plugin only makes sense while WP_DEBUG_LOG is on
    if (!state.WP_DEBUG_LOG) {
      try { removeMuPlugin(sitePath); } catch (_) {}
    }
    return true;
  });

  ipcMain.handle('wpdebug:setMuPlugin', (evt: any, { sitePath, enabled }: any) => {
    if (!isValidSitePath(sitePath)) throw new Error('Invalid site path');
    try {
      if (enabled) {
        const ok = installMuPlugin(sitePath);
        if (!ok) throw new Error('Failed to install mu-plugin');
      } else {
        removeMuPlugin(sitePath);
      }
      return { enabled: fs.existsSync(getMuPluginPath(sitePath)) };
    } catch (e: any) {
      throw new Error(`Failed to update mu-plugin: ${e.message}`);
    }
  });

  ipcMain.handle('wpdebug:readLog', (evt: any, { sitePath, logPath }: any) => {
    if (!isValidSitePath(sitePath)) throw new Error('Invalid site path');
    const { defaultLogPath } = getPaths(sitePath);
    const p = logPath || defaultLogPath;
    if (logPath && !isValidLogPath(logPath, sitePath)) throw new Error('Invalid log path');
    try {
      if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
      return '';
    } catch (e: any) {
      return `Error reading log: ${e.message}`;
    }
  });

  ipcMain.handle('wpdebug:openLog', async (evt: any, { sitePath, logPath }: any) => {
    if (!isValidSitePath(sitePath)) throw new Error('Invalid site path');
    const { defaultLogPath } = getPaths(sitePath);
    const p = logPath || defaultLogPath;
    if (logPath && !isValidLogPath(logPath, sitePath)) throw new Error('Invalid log path');
    ensureFile(p);
    try {
      if (shell) {
        await shell.openPath(p);
      }
      return true;
    } catch (e) {
      return false;
    }
  });

  ipcMain.handle('wpdebug:clearLog', (evt: any, { sitePath, logPath }: any) => {
    if (!isValidSitePath(sitePath)) throw new Error('Invalid site path');
    const { defaultLogPath } = getPaths(sitePath);
    const p = logPath || defaultLogPath;
    if (logPath && !isValidLogPath(logPath, sitePath)) throw new Error('Invalid log path');
    try {
      fs.writeFileSync(p, '', 'utf8');
      return true;
    } catch (e: any) {
      throw new Error(`Failed to clear log: ${e.message}`);
    }
  });

  // ── WP Config Editor Handlers ──

  ipcMain.handle('wpconfig:read', (evt: any, { sitePath }: any) => {
    if (!isValidSitePath(sitePath)) throw new Error('Invalid site path');
    try {
      const { configPath } = getPaths(sitePath);
      if (!fs.existsSync(configPath)) {
        return { content: '', exists: false, path: configPath };
      }
      const content = fs.readFileSync(configPath, 'utf8');
      return { content, exists: true, path: configPath };
    } catch (e: any) {
      throw new Error(`Failed to read wp-config.php: ${e.message}`);
    }
  });

  ipcMain.handle('wpconfig:write', (evt: any, { sitePath, content }: any) => {
    if (!isValidSitePath(sitePath)) throw new Error('Invalid site path');
    try {
      const { configPath } = getPaths(sitePath);
      // Always create a backup before writing
      const bakPath = configPath + '.toolkit.bak';
      if (fs.existsSync(configPath)) {
        const current = fs.readFileSync(configPath, 'utf8');
        fs.writeFileSync(bakPath, current, 'utf8');
      }
      fs.writeFileSync(configPath, content, 'utf8');
      return { success: true, path: configPath };
    } catch (e: any) {
      throw new Error(`Failed to write wp-config.php: ${e.message}`);
    }
  });

  ipcMain.handle('wpconfig:openInEditor', async (evt: any, { sitePath }: any) => {
    if (!isValidSitePath(sitePath)) throw new Error('Invalid site path');
    try {
      const { configPath } = getPaths(sitePath);
      if (shell) {
        await shell.openPath(configPath);
      }
      return true;
    } catch (e) {
      return false;
    }
  });

  // ── PHP Settings Handlers ──

  ipcMain.handle('phpsettings:read', (evt: any, { sitePath, phpVersion, siteId }: any) => {
    if (!isValidSitePath(sitePath)) throw new Error('Invalid site path');
    try {
      const expanded = expandPath(sitePath);
      // Per the Local docs, edit the existing file in the site's /conf directory
      const hbsPath = path.join(expanded, 'conf', 'php', 'php.ini.hbs');
      const exists = fs.existsSync(hbsPath);
      const iniSettings = exists ? readPhpIni(hbsPath) : {};
      const settings: any = {};
      if (iniSettings.max_input_vars != null) settings.max_input_vars = iniSettings.max_input_vars;
      if (iniSettings.memory_limit != null) settings.memory_limit = iniSettings.memory_limit;
      if (iniSettings.post_max_size != null) settings.post_max_size = iniSettings.post_max_size;
      if (iniSettings.upload_max_filesize != null) settings.upload_max_filesize = iniSettings.upload_max_filesize;
      if (iniSettings.max_input_time != null) settings.max_input_time = iniSettings.max_input_time;

      return {
        settings,
        iniPath: hbsPath,
        exists,
      };
    } catch (e: any) {
      throw new Error(`Failed to read PHP settings: ${e.message}`);
    }
  });

  ipcMain.handle('phpsettings:write', (evt: any, { sitePath, settings, phpVersion, siteId }: any) => {
    if (!isValidSitePath(sitePath)) throw new Error('Invalid site path');
    try {
      const expanded = expandPath(sitePath);
      const hbsPath = path.join(expanded, 'conf', 'php', 'php.ini.hbs');

      if (!fs.existsSync(hbsPath)) {
        throw new Error(`Config file not found: ${hbsPath}`);
      }

      // Safe in-place update — only changes matching key=value lines
      const ok = updatePhpIniLines(hbsPath, settings);
      if (!ok) {
        throw new Error('No matching settings found to update');
      }

      return {
        success: true,
        updated: [hbsPath],
      };
    } catch (e: any) {
      throw new Error(`Failed to write PHP settings: ${e.message}`);
    }
  });

  ipcMain.handle('phpsettings:openInEditor', async (evt: any, { sitePath, phpVersion, siteId }: any) => {
    if (!isValidSitePath(sitePath)) throw new Error('Invalid site path');
    try {
      const expanded = expandPath(sitePath);
      const hbsPath = path.join(expanded, 'conf', 'php', 'php.ini.hbs');
      if (shell) {
        await shell.openPath(hbsPath);
      }
      return true;
    } catch (e) {
      return false;
    }
  });

  // ── Update Check Handler ──

  ipcMain.handle('wpdebug:checkForUpdate', async () => {
    try {
      const https = require('https');
      const pkg = require('../package.json');
      const currentVersion = pkg.version;
      const repo = 'EverleeLabs/local-debug-toolkit';

      const data: string = await new Promise((resolve, reject) => {
        const req = https.get(`https://api.github.com/repos/${repo}/releases/latest`, {
          headers: { 'User-Agent': 'local-debug-toolkit' }
        }, (res: any) => {
          if (res.statusCode === 404) {
            resolve('');
            return;
          }
          let body = '';
          res.on('data', (chunk: string) => { body += chunk; });
          res.on('end', () => resolve(body));
        });
        req.on('error', reject);
        req.setTimeout(5000, () => { req.destroy(); reject(new Error('timeout')); });
      });

      if (!data) return { updateAvailable: false, currentVersion };

      const release = JSON.parse(data);
      const latestVersion = (release.tag_name || '').replace(/^v/, '');
      if (!latestVersion) return { updateAvailable: false, currentVersion };

      // Simple semver comparison
      const current = currentVersion.split('.').map(Number);
      const latest = latestVersion.split('.').map(Number);
      let newer = false;
      for (let i = 0; i < 3; i++) {
        if ((latest[i] || 0) > (current[i] || 0)) { newer = true; break; }
        if ((latest[i] || 0) < (current[i] || 0)) break;
      }

      return {
        updateAvailable: newer,
        currentVersion,
        latestVersion,
        releaseUrl: release.html_url || '',
        releaseNotes: release.body || '',
        downloadUrl: (release.assets && release.assets[0] && release.assets[0].browser_download_url) || release.html_url || '',
      };
    } catch (e: any) {
      console.log('Local Debug Toolkit: Update check failed:', e.message);
      return { updateAvailable: false, error: e.message };
    }
  });

  ipcMain.handle('wpdebug:performUpdate', async (evt: any, { downloadUrl }: any) => {
    // Only allow downloads from known GitHub release URLs
    const allowed = [
      'https://github.com/EverleeLabs/',
      'https://objects.githubusercontent.com/',
    ];
    if (!allowed.some(prefix => downloadUrl.startsWith(prefix))) {
      throw new Error('Invalid download URL');
    }

    const tmpFile = path.join(os.tmpdir(), 'local-debug-toolkit-update.tar.gz');
    const tmpDir = path.join(os.tmpdir(), `local-debug-toolkit-update-${Date.now()}`);

    const downloadFile = (url: string, dest: string): Promise<void> => {
      return new Promise((resolve, reject) => {
        const follow = (u: string) => {
          const client = u.startsWith('https') ? require('https') : require('http');
          const req = client.get(u, { headers: { 'User-Agent': 'local-debug-toolkit' } }, (res: any) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
              follow(res.headers.location);
              return;
            }
            if (res.statusCode !== 200) {
              reject(new Error(`Download failed: HTTP ${res.statusCode}`));
              return;
            }
            const out = fs.createWriteStream(dest);
            res.pipe(out);
            out.on('finish', () => out.close(() => resolve()));
            out.on('error', reject);
          });
          req.on('error', reject);
          req.setTimeout(30000, () => { req.destroy(); reject(new Error('Download timed out')); });
        };
        follow(url);
      });
    };

    const extractTar = (tarPath: string, destDir: string): Promise<void> => {
      const { execFile } = require('child_process');
      return new Promise((resolve, reject) => {
        execFile('tar', ['-xzf', tarPath, '-C', destDir], (err: any) => {
          err ? reject(err) : resolve();
        });
      });
    };

    const copyDir = (src: string, dest: string) => {
      if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
      for (const entry of fs.readdirSync(src)) {
        const s = path.join(src, entry);
        const d = path.join(dest, entry);
        fs.statSync(s).isDirectory() ? copyDir(s, d) : fs.copyFileSync(s, d);
      }
    };

    try {
      await downloadFile(downloadUrl, tmpFile);

      fs.mkdirSync(tmpDir, { recursive: true });
      await extractTar(tmpFile, tmpDir);

      const addonDir = path.join(
        os.homedir(), 'Library', 'Application Support', 'Local', 'addons', 'local-debug-toolkit'
      );
      if (!fs.existsSync(addonDir)) throw new Error('Addon install directory not found');

      const srcDir = path.join(tmpDir, 'local-debug-toolkit');
      if (!fs.existsSync(srcDir)) throw new Error('Unexpected archive structure');

      copyDir(srcDir, addonDir);
      return { success: true };
    } finally {
      try { fs.unlinkSync(tmpFile); } catch (_) {}
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    }
  });

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
} catch (e: any) {
  console.log('Local Debug Toolkit: Could not get electron directly:', e.message);
}

module.exports = (context: any) => {
  // If handlers weren't registered yet, try from context
  if (!ipcMain && context && context.electron) {
    ipcMain = context.electron.ipcMain;
    shell = context.electron.shell;
    if (ipcMain) {
      registerHandlers();
    }
  }

  // Capture service container for site restarts
  try {
    const { getServiceContainer } = require('@getflywheel/local/main');
    serviceContainer = getServiceContainer().cradle;
  } catch (_) {
    // Service container may not be available in all environments
  }
};
