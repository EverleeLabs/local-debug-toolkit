const addonID = 'local-debug-toolkit';

// Cache for Local Components
let LocalComponentsCache = null;

const getLocalComponents = () => {
	if (LocalComponentsCache !== null) {
		return LocalComponentsCache;
	}

	let components = null;

	try {
		components = require('@getflywheel/local-components');
	} catch (e) {
		console.warn('Local Debug Toolkit: require() failed:', e.message);
	}

	if (!components && typeof window !== 'undefined') {
		try {
			if (window.LocalComponents) {
				components = window.LocalComponents;
			}
		} catch (e) {}
	}

	if (!components || Object.keys(components).length === 0) {
		try {
			const nodeRequire = typeof __non_webpack_require__ !== 'undefined' ? __non_webpack_require__ : require;
			const evalComponents = nodeRequire('@getflywheel/local-components');
			if (evalComponents && Object.keys(evalComponents).length > 0) {
				components = evalComponents;
			}
		} catch (e) {}
	}

	if (components && typeof components === 'object' && components !== null) {
		const toggle = components.Toggle || components.ToggleSwitch || components.Switch;
		const text = components.Text;
		const button = components.Button;

		if (toggle && text) {
			LocalComponentsCache = {
				Toggle: toggle,
				Text: text,
				Button: button,
				available: true
			};
			return LocalComponentsCache;
		}
	}

	LocalComponentsCache = { Toggle: null, Text: null, Button: null, available: false };
	return LocalComponentsCache;
};

export default function (context) {
	const { React, hooks, notifier, electron } = context;
	const { useState, useEffect, useRef, createElement } = React;
	const ReactForJSX = React;

	// Try to load Local Components at module level
	let moduleLevelComponents = null;
	try {
		const modComponents = require('@getflywheel/local-components');
		if (modComponents && typeof modComponents === 'object') {
			const toggle = modComponents.Toggle || modComponents.ToggleSwitch || modComponents.Switch;
			const text = modComponents.Text;
			if (toggle && text) {
				moduleLevelComponents = {
					Toggle: toggle,
					Text: text,
					Button: modComponents.Button,
					available: true
				};
			}
		}
	} catch (e) {}

	// Helper to resolve components
	const resolveComponents = () => {
		let localComponents = moduleLevelComponents;
		if (!localComponents || !localComponents.available) {
			LocalComponentsCache = null;
			localComponents = getLocalComponents();
		}
		return localComponents;
	};

	// ── Shared styles ──

	const buttonStyle = {
		padding: '6px 12px',
		fontSize: '13px',
		fontWeight: '700',
		cursor: 'pointer',
		border: '2px solid #267048',
		backgroundColor: 'transparent',
		color: '#267048',
		borderRadius: '50px',
		transition: 'all 0.2s ease',
		outline: 'none',
		fontFamily: 'inherit'
	};

	const buttonHoverIn = (e) => {
		e.target.style.backgroundColor = '#51bb7b';
		e.target.style.color = '#fff';
		e.target.style.border = 'none';
	};

	const buttonHoverOut = (e) => {
		e.target.style.backgroundColor = 'transparent';
		e.target.style.color = '#267048';
		e.target.style.border = '2px solid #267048';
	};

	// ── Render a styled button (fallback or Local Components) ──

	const renderButton = (components, { key, onClick, disabled, children }) => {
		if (components && components.available && components.Button) {
			return ReactForJSX.createElement(components.Button, {
				key, onClick, disabled, size: 'small'
			}, children);
		}
		return ReactForJSX.createElement('button', {
			key, onClick, disabled, type: 'button',
			style: { ...buttonStyle, opacity: disabled ? 0.6 : 1, cursor: disabled ? 'not-allowed' : 'pointer' },
			onMouseEnter: disabled ? undefined : buttonHoverIn,
			onMouseLeave: disabled ? undefined : buttonHoverOut
		}, children);
	};

	// ── Render toggle or checkbox ──

	const renderToggle = (components, checked, onChange, label, key) => {
		if (components && components.available && components.Toggle && components.Text) {
			const toggleOnChange = (newValue) => {
				const finalValue = typeof newValue === 'boolean' ? newValue : !checked;
				onChange(finalValue);
			};
			return ReactForJSX.createElement('div', {
				key, style: { display: 'flex', alignItems: 'center', gap: 12 }
			}, [
				ReactForJSX.createElement(components.Toggle, { key: 'toggle', checked, onChange: toggleOnChange }),
				ReactForJSX.createElement(components.Text, { key: 'label', style: { marginLeft: 8 } }, label)
			]);
		}

		// Fallback styled toggle
		const handleToggleClick = () => onChange(!checked);
		return ReactForJSX.createElement('div', {
			key,
			style: { display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer', userSelect: 'none' },
			onClick: handleToggleClick
		}, [
			ReactForJSX.createElement('div', {
				key: 'toggle-track',
				style: {
					position: 'relative', width: 40, height: 20,
					backgroundColor: checked ? '#267048' : '#D0D0D0',
					borderRadius: 10, transition: 'background-color 0.2s ease', flexShrink: 0
				}
			}, [
				ReactForJSX.createElement('div', {
					key: 'toggle-thumb',
					style: {
						position: 'absolute', top: 2, left: checked ? 20 : 2,
						width: 16, height: 16, backgroundColor: '#fff', borderRadius: '50%',
						transition: 'left 0.2s ease', boxShadow: '0 1px 3px rgba(0,0,0,0.3)'
					}
				})
			]),
			ReactForJSX.createElement('span', {
				key: 'label',
				style: { fontSize: '14px', color: '#2C3338', fontWeight: 400, lineHeight: '20px' }
			}, label)
		]);
	};

	// ════════════════════════════════════════════
	// Panel 1: WP Debug (existing functionality)
	// ════════════════════════════════════════════

	const WPDebugPanel = (props) => {
		const components = resolveComponents();
		const ipc = electron.ipcRenderer;
		const site = props.site;
		const [WP_DEBUG, setWP_DEBUG] = useState(false);
		const [WP_DEBUG_LOG, setWP_DEBUG_LOG] = useState(false);
		const [WP_DEBUG_DISPLAY, setWP_DEBUG_DISPLAY] = useState(false);
		const [MU_PLUGIN_ENABLED, setMU_PLUGIN_ENABLED] = useState(false);
		const [logContent, setLogContent] = useState('');
		const [logLoading, setLogLoading] = useState(false);

		useEffect(() => {
			if (!site) return;
			ipc.invoke('wpdebug:getState', { sitePath: site.path })
				.then((res) => {
					setWP_DEBUG(res.WP_DEBUG || false);
					setWP_DEBUG_LOG(res.WP_DEBUG_LOG || false);
					setWP_DEBUG_DISPLAY(res.WP_DEBUG_DISPLAY || false);
					setMU_PLUGIN_ENABLED(res.MU_PLUGIN_ENABLED || false);
				})
				.catch(() => {});
		}, [site]);

		useEffect(() => {
			if (!site || !WP_DEBUG_LOG) {
				setLogContent('');
				return;
			}
			setLogLoading(true);
			const sitePath = site.path || site.rootPath || site.directory;
			if (!sitePath) { setLogLoading(false); return; }
			ipc.invoke('wpdebug:readLog', { sitePath })
				.then((content) => { setLogContent(content || ''); setLogLoading(false); })
				.catch((err) => { setLogContent(`Error loading log: ${err.message || 'Unknown error'}`); setLogLoading(false); });
		}, [site, WP_DEBUG_LOG]);

		const loadDebugLog = () => {
			if (!site || !WP_DEBUG_LOG) { setLogContent(''); return; }
			setLogLoading(true);
			const sitePath = site.path || site.rootPath || site.directory;
			if (!sitePath) { setLogLoading(false); return; }
			ipc.invoke('wpdebug:readLog', { sitePath })
				.then((content) => { setLogContent(content || ''); setLogLoading(false); })
				.catch((err) => { setLogContent(`Error loading log: ${err.message || 'Unknown error'}`); setLogLoading(false); });
		};

		const openLogFile = () => {
			if (!site) return;
			const sitePath = site.path || site.rootPath || site.directory;
			if (!sitePath) return;
			ipc.invoke('wpdebug:openLog', { sitePath })
				.catch((err) => { notifier.notify({ title: 'WP Debug Error', message: `Failed to open log file: ${err.message || 'Unknown error'}` }); });
		};

		const clearLogFile = () => {
			if (!site) return;
			const sitePath = site.path || site.rootPath || site.directory;
			if (!sitePath) return;
			ipc.invoke('wpdebug:clearLog', { sitePath })
				.then(() => { loadDebugLog(); notifier.notify({ title: 'WP Debug', message: 'Debug log cleared successfully' }); })
				.catch((err) => { notifier.notify({ title: 'WP Debug Error', message: `Failed to clear log file: ${err.message || 'Unknown error'}` }); });
		};

		const saveState = (newState) => {
			if (!site) { notifier.notify({ title: 'WP Debug Error', message: 'Site path not found' }); return Promise.reject('No site'); }
			const sitePath = site.path || site.rootPath || site.directory;
			if (!sitePath) { notifier.notify({ title: 'WP Debug Error', message: 'Site path not found' }); return Promise.reject('No site path'); }
			return ipc.invoke('wpdebug:getState', { sitePath })
				.then((currentState) => {
					return ipc.invoke('wpdebug:setState', {
						sitePath,
						state: {
							WP_DEBUG: newState.WP_DEBUG !== undefined ? newState.WP_DEBUG : currentState.WP_DEBUG,
							WP_DEBUG_DISPLAY: newState.WP_DEBUG_DISPLAY !== undefined ? newState.WP_DEBUG_DISPLAY : currentState.WP_DEBUG_DISPLAY,
							WP_DEBUG_LOG: newState.WP_DEBUG_LOG !== undefined ? newState.WP_DEBUG_LOG : currentState.WP_DEBUG_LOG
						}
					});
				})
				.then(() => {
					if (notifier && typeof notifier.notify === 'function') {
						const setting = Object.keys(newState)[0];
						const value = newState[setting];
						notifier.notify({ title: 'WP Debug', message: `${setting} ${value ? 'enabled' : 'disabled'}` });
					}
				})
				.catch((err) => {
					console.error('Error saving state:', err);
					notifier.notify({ title: 'WP Debug Error', message: err.message || 'Failed to save' });
				});
		};

		const handleToggle = (key, setter, currentVal) => (value) => {
			let checked = typeof value === 'boolean' ? value : !currentVal;
			setter(checked);
			saveState({ [key]: checked });
			// Mirror the backend's auto-clean: turning WP_DEBUG_LOG off removes the mu-plugin
			if (key === 'WP_DEBUG_LOG' && !checked) setMU_PLUGIN_ENABLED(false);
		};

		const handleMuPluginToggle = (value) => {
			const checked = typeof value === 'boolean' ? value : !MU_PLUGIN_ENABLED;
			setMU_PLUGIN_ENABLED(checked);
			if (!site) return;
			const sitePath = site.path || site.rootPath || site.directory;
			if (!sitePath) return;
			ipc.invoke('wpdebug:setMuPlugin', { sitePath, enabled: checked })
				.then((res) => {
					setMU_PLUGIN_ENABLED(!!(res && res.enabled));
					notifier.notify({
						title: 'WP Debug',
						message: checked ? 'In-admin log viewer installed (Tools → Debug Log)' : 'In-admin log viewer removed'
					});
				})
				.catch((err) => {
					setMU_PLUGIN_ENABLED(!checked);
					notifier.notify({ title: 'WP Debug Error', message: err.message || 'Failed to update mu-plugin' });
				});
		};

		return ReactForJSX.createElement('div', {
			style: { flex: '1', overflowY: 'auto', margin: '10px', padding: '24px' }
		}, [
			ReactForJSX.createElement('h2', { key: 'title' }, 'WP Debug'),

			ReactForJSX.createElement('div', {
				key: 'toggles',
				style: { marginTop: 20, display: 'flex', flexDirection: 'column', gap: 20 }
			}, [
				renderToggle(components, WP_DEBUG, handleToggle('WP_DEBUG', setWP_DEBUG, WP_DEBUG), 'WP_DEBUG', 'wp-debug'),
				WP_DEBUG ? ReactForJSX.createElement('div', { key: 'wp-debug-log-wrapper', style: { marginLeft: 20, display: 'flex', flexDirection: 'column', gap: 12 } }, [
					renderToggle(components, WP_DEBUG_LOG, handleToggle('WP_DEBUG_LOG', setWP_DEBUG_LOG, WP_DEBUG_LOG), 'WP_DEBUG_LOG', 'wp-debug-log'),
					WP_DEBUG_LOG ? ReactForJSX.createElement('div', { key: 'mu-plugin-wrapper', style: { marginLeft: 20 } }, [
						renderToggle(components, MU_PLUGIN_ENABLED, handleMuPluginToggle, 'Show in WP Admin (Tools → Debug Log)', 'mu-plugin')
					]) : null
				].filter(Boolean)) : null,
				WP_DEBUG ? ReactForJSX.createElement('div', { key: 'wp-debug-display-wrapper', style: { marginLeft: 20 } }, [
					renderToggle(components, WP_DEBUG_DISPLAY, handleToggle('WP_DEBUG_DISPLAY', setWP_DEBUG_DISPLAY, WP_DEBUG_DISPLAY), 'WP_DEBUG_DISPLAY', 'wp-debug-display')
				]) : null,

				// Debug log viewer
				WP_DEBUG_LOG ? ReactForJSX.createElement('div', {
					key: 'debug-log-viewer', style: { marginTop: 30, marginLeft: 20 }
				}, [
					ReactForJSX.createElement('div', {
						key: 'log-header',
						style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }
					}, [
						components && components.Text
							? ReactForJSX.createElement(components.Text, { key: 'log-title', style: { fontWeight: 'bold', fontSize: '14px' } }, 'Debug Log')
							: ReactForJSX.createElement('h3', { key: 'log-title', style: { margin: 0, fontSize: '14px' } }, 'Debug Log'),
						ReactForJSX.createElement('div', { key: 'log-actions', style: { display: 'flex', gap: 8 } }, [
							renderButton(components, { key: 'refresh-btn', onClick: loadDebugLog, disabled: logLoading, children: logLoading ? 'Loading...' : 'Refresh' }),
							renderButton(components, { key: 'clear-btn', onClick: clearLogFile, children: 'Clear Log' }),
							renderButton(components, { key: 'open-btn', onClick: openLogFile, children: 'Open File' })
						])
					]),
					ReactForJSX.createElement('textarea', {
						key: 'log-content', readOnly: true,
						value: logContent || (logLoading ? 'Loading...' : 'No log entries yet.'),
						style: {
							width: '100%', height: '300px', fontFamily: 'monospace', fontSize: '12px',
							padding: '12px', border: '1px solid #ddd', borderRadius: '4px',
							backgroundColor: '#f5f5f5', resize: 'vertical', overflowY: 'auto',
							whiteSpace: 'pre', wordWrap: 'off'
						}
					})
				]) : null
			].filter(Boolean))
		]);
	};

	// ════════════════════════════════════════════
	// Panel 2: WP Config Editor (new feature)
	// ════════════════════════════════════════════

	const WPConfigPanel = (props) => {
		const components = resolveComponents();
		const ipc = electron.ipcRenderer;
		const site = props.site;
		const [content, setContent] = useState('');
		const [savedContent, setSavedContent] = useState('');
		const [loading, setLoading] = useState(true);
		const [saving, setSaving] = useState(false);
		const [configPath, setConfigPath] = useState('');
		const [exists, setExists] = useState(false);

		const hasChanges = content !== savedContent;

		// Load wp-config.php on mount
		useEffect(() => {
			if (!site) return;
			const sitePath = site.path || site.rootPath || site.directory;
			if (!sitePath) return;

			setLoading(true);
			ipc.invoke('wpconfig:read', { sitePath })
				.then((res) => {
					setContent(res.content);
					setSavedContent(res.content);
					setConfigPath(res.path);
					setExists(res.exists);
					setLoading(false);
				})
				.catch((err) => {
					setContent('');
					setSavedContent('');
					setLoading(false);
					notifier.notify({ title: 'WP Config Error', message: err.message || 'Failed to load wp-config.php' });
				});
		}, [site]);

		const handleSave = () => {
			if (!site || !hasChanges) return;
			const sitePath = site.path || site.rootPath || site.directory;
			if (!sitePath) return;

			setSaving(true);
			ipc.invoke('wpconfig:write', { sitePath, content })
				.then(() => {
					setSavedContent(content);
					setSaving(false);
					notifier.notify({ title: 'WP Config', message: 'wp-config.php saved successfully' });
				})
				.catch((err) => {
					setSaving(false);
					notifier.notify({ title: 'WP Config Error', message: err.message || 'Failed to save wp-config.php' });
				});
		};

		const handleRevert = () => {
			setContent(savedContent);
		};

		const handleReload = () => {
			if (!site) return;
			const sitePath = site.path || site.rootPath || site.directory;
			if (!sitePath) return;

			setLoading(true);
			ipc.invoke('wpconfig:read', { sitePath })
				.then((res) => {
					setContent(res.content);
					setSavedContent(res.content);
					setConfigPath(res.path);
					setExists(res.exists);
					setLoading(false);
				})
				.catch((err) => {
					setLoading(false);
					notifier.notify({ title: 'WP Config Error', message: err.message || 'Failed to reload wp-config.php' });
				});
		};

		const handleOpenInEditor = () => {
			if (!site) return;
			const sitePath = site.path || site.rootPath || site.directory;
			if (!sitePath) return;
			ipc.invoke('wpconfig:openInEditor', { sitePath })
				.catch((err) => {
					notifier.notify({ title: 'WP Config Error', message: 'Failed to open file in external editor' });
				});
		};

		if (loading) {
			return ReactForJSX.createElement('div', {
				style: { flex: '1', overflowY: 'auto', margin: '10px', padding: '24px' }
			}, [
				ReactForJSX.createElement('h2', { key: 'title' }, 'WP Config'),
				ReactForJSX.createElement('p', { key: 'loading', style: { color: '#666' } }, 'Loading wp-config.php...')
			]);
		}

		if (!exists) {
			return ReactForJSX.createElement('div', {
				style: { flex: '1', overflowY: 'auto', margin: '10px', padding: '24px' }
			}, [
				ReactForJSX.createElement('h2', { key: 'title' }, 'WP Config'),
				ReactForJSX.createElement('p', { key: 'not-found', style: { color: '#999' } }, 'wp-config.php not found for this site.')
			]);
		}

		return ReactForJSX.createElement('div', {
			style: { flex: '1', overflowY: 'auto', margin: '10px', padding: '24px', display: 'flex', flexDirection: 'column' }
		}, [
			// Header
			ReactForJSX.createElement('div', {
				key: 'header',
				style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }
			}, [
				ReactForJSX.createElement('h2', { key: 'title', style: { margin: 0 } }, 'WP Config'),
				ReactForJSX.createElement('div', { key: 'actions', style: { display: 'flex', gap: 8 } }, [
					renderButton(components, {
						key: 'save-btn', onClick: handleSave, disabled: !hasChanges || saving,
						children: saving ? 'Saving...' : 'Save'
					}),
					renderButton(components, {
						key: 'revert-btn', onClick: handleRevert, disabled: !hasChanges,
						children: 'Revert'
					}),
					renderButton(components, { key: 'reload-btn', onClick: handleReload, children: 'Reload' }),
					renderButton(components, { key: 'open-btn', onClick: handleOpenInEditor, children: 'Open in Editor' })
				])
			]),

			// File path display
			ReactForJSX.createElement('p', {
				key: 'filepath',
				style: { fontSize: '12px', color: '#888', margin: '0 0 12px 0', fontFamily: 'monospace' }
			}, configPath),

			// Unsaved changes indicator
			hasChanges ? ReactForJSX.createElement('div', {
				key: 'unsaved',
				style: {
					padding: '8px 12px', marginBottom: 12, backgroundColor: '#FFF3CD',
					border: '1px solid #FFEAA7', borderRadius: '4px', fontSize: '13px', color: '#856404'
				}
			}, 'You have unsaved changes') : null,

			// Editor textarea
			ReactForJSX.createElement('textarea', {
				key: 'editor',
				value: content,
				onChange: (e) => setContent(e.target.value),
				spellCheck: false,
				style: {
					flex: 1, minHeight: '500px', fontFamily: 'monospace', fontSize: '13px',
					lineHeight: '1.5', padding: '16px', border: '1px solid #ddd', borderRadius: '4px',
					backgroundColor: '#1e1e1e', color: '#d4d4d4', resize: 'vertical',
					overflowY: 'auto', whiteSpace: 'pre', tabSize: 4, outline: 'none'
				},
				onKeyDown: (e) => {
					// Handle Tab key for indentation
					if (e.key === 'Tab') {
						e.preventDefault();
						const textarea = e.target;
						const start = textarea.selectionStart;
						const end = textarea.selectionEnd;
						const newContent = content.substring(0, start) + '\t' + content.substring(end);
						setContent(newContent);
						// Restore cursor position after React re-renders
						setTimeout(() => {
							textarea.selectionStart = textarea.selectionEnd = start + 1;
						}, 0);
					}
					// Handle Ctrl/Cmd+S to save
					if ((e.ctrlKey || e.metaKey) && e.key === 's') {
						e.preventDefault();
						if (hasChanges && !saving) handleSave();
					}
				}
			})
		].filter(Boolean));
	};

	// ════════════════════════════════════════════
	// Panel 3: PHP Settings (new feature)
	// ════════════════════════════════════════════

	const PHPSettingsPanel = (props) => {
		const components = resolveComponents();
		const ipc = electron.ipcRenderer;
		const site = props.site;
		const [settings, setSettings] = useState({});
		const [savedSettings, setSavedSettings] = useState({});
		const [loading, setLoading] = useState(true);
		const [saving, setSaving] = useState(false);
		const [iniPath, setIniPath] = useState('');
		const [exists, setExists] = useState(false);

		const hasChanges = JSON.stringify(settings) !== JSON.stringify(savedSettings);

		// Load PHP settings on mount
		useEffect(() => {
			if (!site) return;
			const sitePath = site.path || site.rootPath || site.directory;
			if (!sitePath) return;
			setLoading(true);
			ipc.invoke('phpsettings:read', { sitePath, phpVersion: site.services && site.services.php && site.services.php.version, siteId: site.id })
				.then((res) => {
					setSettings(res.settings);
					setSavedSettings(res.settings);
					setIniPath(res.iniPath || '');
					setExists(res.exists);
					setLoading(false);
				})
				.catch((err) => {
					setSettings({});
					setSavedSettings({});
					setLoading(false);
					notifier.notify({ title: 'PHP Settings Error', message: err.message || 'Failed to load PHP settings' });
				});
		}, [site]);

		const handleSettingChange = (key, value) => {
			setSettings(prev => ({ ...prev, [key]: value }));
		};

		const handleSave = () => {
			if (!site || !hasChanges) return;
			const sitePath = site.path || site.rootPath || site.directory;
			if (!sitePath) return;

			// Final validation before saving
			const errors = [];
			if (settings.max_input_vars) {
				const num = parseInt(settings.max_input_vars);
				if (isNaN(num) || num < 1 || num > 10000) {
					errors.push('max_input_vars must be between 1 and 10000');
				}
			}
			if (settings.memory_limit) {
				const memoryRegex = /^(\d+)([KMGT])$/i;
				if (!memoryRegex.test(settings.memory_limit)) {
					errors.push('memory_limit must be in format like 256M, 512M, 1G');
				}
			}
			if (settings.post_max_size) {
				const sizeRegex = /^(\d+)([KMGT])$/i;
				if (!sizeRegex.test(settings.post_max_size)) {
					errors.push('post_max_size must be in format like 1000M, 2G');
				}
			}
			if (settings.upload_max_filesize) {
				const sizeRegex = /^(\d+)([KMGT])$/i;
				if (!sizeRegex.test(settings.upload_max_filesize)) {
					errors.push('upload_max_filesize must be in format like 300M, 1G');
				}
			}
			if (settings.max_input_time) {
				const num = parseInt(settings.max_input_time);
				if (isNaN(num) || num < -1 || num > 86400) {
					errors.push('max_input_time must be between -1 and 86400');
				}
			}
			if (errors.length > 0) {
				notifier.notify({ title: 'Validation Error', message: errors.join('; ') });
				return;
			}

			setSaving(true);
			ipc.invoke('phpsettings:write', { sitePath, settings, phpVersion: site.services && site.services.php && site.services.php.version, siteId: site.id })
				.then(() => {
					setSavedSettings({ ...settings });
					setSaving(false);
					notifier.notify({ title: 'PHP Settings', message: 'PHP settings saved successfully. You may need to restart the site for changes to take effect.' });
					handleReload();
				})
				.catch((err) => {
					setSaving(false);
					notifier.notify({ title: 'PHP Settings Error', message: err.message || 'Failed to save PHP settings' });
				});
		};

		const handleRevert = () => {
			setSettings({ ...savedSettings });
		};

		const handleReload = () => {
			if (!site) return;
			const sitePath = site.path || site.rootPath || site.directory;
			if (!sitePath) return;

			setLoading(true);
			ipc.invoke('phpsettings:read', { sitePath, phpVersion: site.services && site.services.php && site.services.php.version, siteId: site.id })
				.then((res) => {
					setSettings(res.settings);
					setSavedSettings(res.settings);
					setIniPath(res.iniPath || '');
					setExists(res.exists);
					setLoading(false);
				})
				.catch((err) => {
					setLoading(false);
					notifier.notify({ title: 'PHP Settings Error', message: err.message || 'Failed to reload PHP settings' });
				});
		};

		const handleOpenInEditor = () => {
			if (!site) return;
			const sitePath = site.path || site.rootPath || site.directory;
			if (!sitePath) return;
			ipc.invoke('phpsettings:openInEditor', { sitePath, phpVersion: site.services && site.services.php && site.services.php.version, siteId: site.id })
				.catch((err) => {
					notifier.notify({ title: 'PHP Settings Error', message: 'Failed to open file in external editor' });
				});
		};

		const renderSettingInput = (key, label, type = 'text') => {
			const value = settings[key] || '';
			const onChange = (e) => handleSettingChange(key, e.target.value);

			return ReactForJSX.createElement('div', {
				key,
				style: { marginBottom: 16 }
			}, [
				ReactForJSX.createElement('label', {
					key: 'label',
					style: { display: 'block', fontSize: '14px', fontWeight: 'bold', marginBottom: 4 }
				}, label),
				ReactForJSX.createElement('input', {
					key: 'input',
					type,
					value,
					onChange,
					style: {
						width: '100%', padding: '8px 12px', border: '1px solid #ddd',
						borderRadius: '4px', fontSize: '14px', fontFamily: 'monospace'
					}
				})
			]);
		};

		if (loading) {
			return ReactForJSX.createElement('div', {
				style: { flex: '1', overflowY: 'auto', margin: '10px', padding: '24px' }
			}, [
				ReactForJSX.createElement('h2', { key: 'title' }, 'PHP Settings'),
				ReactForJSX.createElement('p', { key: 'loading', style: { color: '#666' } }, 'Loading PHP settings...')
			]);
		}

		return ReactForJSX.createElement('div', {
			style: { flex: '1', overflowY: 'auto', margin: '10px', padding: '24px', display: 'flex', flexDirection: 'column' }
		}, [
			// Header
			ReactForJSX.createElement('div', {
				key: 'header',
				style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }
			}, [
				ReactForJSX.createElement('h2', { key: 'title', style: { margin: 0 } }, 'PHP Settings'),
				ReactForJSX.createElement('div', { key: 'actions', style: { display: 'flex', gap: 8 } }, [
					renderButton(components, {
						key: 'save-btn', onClick: handleSave, disabled: !hasChanges || saving,
						children: saving ? 'Saving...' : 'Save'
					}),
					renderButton(components, {
						key: 'revert-btn', onClick: handleRevert, disabled: !hasChanges,
						children: 'Revert'
					}),
					renderButton(components, { key: 'reload-btn', onClick: handleReload, children: 'Reload' }),
					renderButton(components, { key: 'open-btn', onClick: handleOpenInEditor, children: 'Open in Editor' })
				])
			]),

			// File path display
			ReactForJSX.createElement('div', {
				key: 'filepaths',
				style: { fontSize: '12px', color: '#888', margin: '0 0 12px 0', fontFamily: 'monospace' }
			}, `Config: ${iniPath}`),

			// Unsaved changes indicator
			hasChanges ? ReactForJSX.createElement('div', {
				key: 'unsaved',
				style: {
					padding: '8px 12px', marginBottom: 12, backgroundColor: '#FFF3CD',
					border: '1px solid #FFEAA7', borderRadius: '4px', fontSize: '13px', color: '#856404'
				}
			}, 'You have unsaved changes') : null,

			// Settings
			ReactForJSX.createElement('div', {
				key: 'settings',
				style: { flex: 1 }
			}, [
				ReactForJSX.createElement('div', {
					key: 'warning',
					style: {
						padding: '12px 16px', marginBottom: 16, backgroundColor: '#FFF3CD',
						border: '1px solid #FFEAA7', borderRadius: '4px', fontSize: '14px', color: '#856404'
					}
				}, '⚠️ PHP settings modifications may require a site restart to take effect. Local uses Docker containers, so changes to php.ini files may not be immediately applied.'),
				renderSettingInput('memory_limit', 'Memory Limit (e.g., 256M, 512M)'),
				renderSettingInput('post_max_size', 'Post Max Size (e.g., 1000M, 2G)'),
				renderSettingInput('upload_max_filesize', 'Upload Max Filesize (e.g., 300M, 1G)'),
				renderSettingInput('max_input_vars', 'Max Input Vars (e.g., 1000, 2000)', 'number'),
				renderSettingInput('max_input_time', 'Max Input Time in seconds (e.g., 600)', 'number')
			])
		].filter(Boolean));
	};

	// ── Update Banner Component ──

	const UpdateBanner = () => {
		const ipc = electron.ipcRenderer;
		const [update, setUpdate] = useState(null);
		const [dismissed, setDismissed] = useState(false);
		const [updateState, setUpdateState] = useState('idle'); // idle | updating | done | error

		useEffect(() => {
			ipc.invoke('wpdebug:checkForUpdate')
				.then((res) => {
					if (res && res.updateAvailable) setUpdate(res);
				})
				.catch(() => {});
		}, []);

		if (!update || dismissed) return null;

		const handleUpdate = () => {
			const url = update.downloadUrl || '';
			if (!url.startsWith('https://github.com/EverleeLabs/') &&
				!url.startsWith('https://objects.githubusercontent.com/')) return;
			setUpdateState('updating');
			ipc.invoke('wpdebug:performUpdate', { downloadUrl: url })
				.then(() => setUpdateState('done'))
				.catch(() => setUpdateState('error'));
		};

		const handleDownload = (e) => {
			e.preventDefault();
			const url = update.downloadUrl || '';
			if (url.startsWith('https://github.com/EverleeLabs/')) {
				electron.shell.openExternal(url);
			}
		};

		const dismiss = ReactForJSX.createElement('span', {
			key: 'dismiss',
			style: { cursor: 'pointer', marginLeft: 12, fontWeight: 'bold', fontSize: '16px' },
			onClick: () => setDismissed(true)
		}, '\u00D7');

		if (updateState === 'done') {
			return ReactForJSX.createElement('div', {
				style: {
					padding: '10px 14px', marginBottom: 12, backgroundColor: '#D4EDDA',
					border: '1px solid #C3E6CB', borderRadius: '4px', fontSize: '13px',
					color: '#155724', display: 'flex', alignItems: 'center', justifyContent: 'space-between'
				}
			}, [
				ReactForJSX.createElement('span', { key: 'msg' }, 'Update installed — please restart Local to complete.'),
				dismiss
			]);
		}

		if (updateState === 'error') {
			return ReactForJSX.createElement('div', {
				style: {
					padding: '10px 14px', marginBottom: 12, backgroundColor: '#F8D7DA',
					border: '1px solid #F5C6CB', borderRadius: '4px', fontSize: '13px',
					color: '#721C24', display: 'flex', alignItems: 'center', justifyContent: 'space-between'
				}
			}, [
				ReactForJSX.createElement('span', { key: 'msg' }, [
					'Update failed. ',
					ReactForJSX.createElement('a', {
						key: 'dl', href: '#',
						style: { color: '#721C24', fontWeight: 'bold', textDecoration: 'underline' },
						onClick: handleDownload
					}, 'Download manually')
				]),
				dismiss
			]);
		}

		return ReactForJSX.createElement('div', {
			style: {
				padding: '10px 14px', marginBottom: 12, backgroundColor: '#D1ECF1',
				border: '1px solid #BEE5EB', borderRadius: '4px', fontSize: '13px',
				color: '#0C5460', display: 'flex', alignItems: 'center', justifyContent: 'space-between'
			}
		}, [
			ReactForJSX.createElement('span', { key: 'msg' },
				`Update available: v${update.latestVersion} (you have v${update.currentVersion})`
			),
			ReactForJSX.createElement('div', { key: 'actions', style: { display: 'flex', alignItems: 'center', gap: 10 } }, [
				ReactForJSX.createElement('button', {
					key: 'update-btn',
					onClick: handleUpdate,
					disabled: updateState === 'updating',
					style: {
						padding: '4px 12px', fontSize: '12px', fontWeight: '700',
						cursor: updateState === 'updating' ? 'not-allowed' : 'pointer',
						border: 'none', backgroundColor: '#0C5460', color: '#fff',
						borderRadius: '50px', opacity: updateState === 'updating' ? 0.7 : 1
					}
				}, updateState === 'updating' ? 'Updating...' : 'Update Now'),
				ReactForJSX.createElement('a', {
					key: 'dl-link', href: '#',
					style: { color: '#0C5460', fontSize: '12px', textDecoration: 'underline' },
					onClick: handleDownload
				}, 'Download'),
				dismiss
			])
		]);
	};

	const withUpdateBanner = (PanelComponent) => (props) => {
		return ReactForJSX.createElement('div', null, [
			ReactForJSX.createElement(UpdateBanner, { key: 'update-banner' }),
			ReactForJSX.createElement(PanelComponent, { key: 'panel', ...props })
		]);
	};

	// ── Register all panels in Tools tab ──

	hooks.addFilter('siteInfoToolsItem', (menu) => [
		...menu,
		{
			menuItem: 'WP Debug',
			path: `/${addonID}/debug`,
			render: withUpdateBanner(WPDebugPanel),
		},
		{
			menuItem: 'WP Config',
			path: `/${addonID}/config`,
			render: withUpdateBanner(WPConfigPanel),
		},
		{
			menuItem: 'PHP Settings',
			path: `/${addonID}/php`,
			render: withUpdateBanner(PHPSettingsPanel),
		},
	]);
}
