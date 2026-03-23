# Local Debug Toolkit

A [Local](https://localwp.com/) addon that gives you tools to debug WordPress sites. Enable debug mode, view the debug log, edit wp-config.php, and modify PHP settings — all per site, right from the Local UI.

## Features

### WP Debug
- Toggle `WP_DEBUG`, `WP_DEBUG_LOG`, and `WP_DEBUG_DISPLAY`
- View and clear the debug log directly in Local
- Open the log file in your default editor

### WP Config
- View and edit `wp-config.php` with a built-in editor
- Automatic backups before any changes
- Open the file in your default editor

### PHP Settings
- Modify PHP settings per site:
  - `memory_limit`
  - `post_max_size`
  - `upload_max_filesize`
  - `max_input_vars`
  - `max_input_time`
- Changes persist across site restarts
- Values are reflected in WordPress Site Health

### Auto-Update Notifications
- Checks GitHub for new releases and displays a banner when an update is available

## Installation

1. Download the latest release `.tar.gz` from the [Releases](https://github.com/EverleeLabs/local-debug-toolkit/releases) page
2. In Local, go to **Add-ons** > **Installed** > **Install from disk**
3. Select the downloaded `.tar.gz` file
4. Restart Local

After installation, the tools appear under the **Tools** tab for each site:
- **WP Debug** — debug toggles and log viewer
- **WP Config** — wp-config.php editor
- **PHP Settings** — per-site PHP configuration

## Usage

### Changing PHP Settings
1. Navigate to your site's **Tools** > **PHP Settings**
2. Modify the values you need
3. Click **Save**
4. Stop and start your site for changes to take effect

> **Note:** PHP settings require a site restart to take effect.

## Development

### Prerequisites
- Node.js
- npm

### Setup
```bash
npm install
```

### Build
```bash
npm run build
```

### Watch (auto-rebuild on changes)
```bash
npm run watch
```

### Package for distribution
```bash
npm run build
tar -czf local-debug-toolkit.tar.gz --exclude='node_modules' --exclude='.git' --exclude='src' --exclude='webpack.config.js' --exclude='tsconfig.json' .
```

## How It Works

The addon edits the per-site `conf/php/php.ini.hbs` template that Local uses to render the runtime PHP configuration. This ensures changes are scoped to individual sites and persist across restarts.

For more background on editing PHP config in Local, see [How to Edit a php.ini File in Flywheel's Local App](https://geoffgraham.me/how-to-edit-a-php-ini-file-in-flywheels-local-app/).

## License

MIT — [Everlee Labs](https://github.com/EverleeLabs)
