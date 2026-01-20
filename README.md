# SN Flow Compare

A Chrome extension for comparing ServiceNow Flow Designer versions side-by-side. Easily visualize differences between your current working version and historical versions.

## Features

- **Side-by-Side Comparison**: View current and historical flow versions in a clean, row-based layout
- **Diff Highlighting**: Steps are color-coded to show what's been added, removed, or modified
- **History Sidebar Integration**: Click any version in Flow Designer's History panel to compare
- **Full Step Extraction**: Automatically opens each step to capture complete configuration details
- **Loading Overlay**: Visual feedback with blur effect while extracting flow steps
- **Keyboard Shortcut**: Quick access via `Alt+Shift+C`
- **Matched Step Heights**: Corresponding steps are displayed at equal heights for easy comparison

## Installation

### From Source (Developer Mode)

1. **Download or Clone** this repository to your local machine:
   ```bash
   git clone https://github.com/your-username/sn-flow-compare.git
   ```

2. **Open Chrome Extensions**:
   - Navigate to `chrome://extensions/` in your Chrome browser
   - Or go to Menu > More Tools > Extensions

3. **Enable Developer Mode**:
   - Toggle the "Developer mode" switch in the top-right corner

4. **Load the Extension**:
   - Click "Load unpacked"
   - Select the folder containing the extension files (`sn-flow-compare`)

5. **Verify Installation**:
   - The extension icon should appear in your Chrome toolbar
   - You should see "SN Flow Compare" in your extensions list

6. **Pin the Extension** (optional):
   - Click the puzzle piece icon in Chrome toolbar
   - Pin "SN Flow Compare" for easy access

## Usage

### Method 1: History Sidebar (Recommended)

1. Open a Flow in **ServiceNow Flow Designer**
2. Click the **History** button (clock icon) in the toolbar
3. In the History sidebar, click on any historical version entry
4. The extension will automatically:
   - Capture your current working version
   - Load the selected historical version
   - Show a loading overlay with progress while extracting steps
   - Open the comparison modal with both versions side-by-side

### Method 2: Keyboard Shortcut

1. Open a Flow in Flow Designer
2. Press `Alt+Shift+C`
3. If you've previously selected a historical version, it will show the comparison
4. Otherwise, it will prompt you to select a version from the History sidebar

You can customize the shortcut at `chrome://extensions/shortcuts`

## Understanding the Comparison View

### Color Coding

| Color | Meaning |
|-------|---------|
| Green border | **Added** - Step exists in current version but not in historical |
| Red border | **Removed** - Step exists in historical version but not in current |
| Orange border | **Modified** - Step exists in both but content has changed |
| Gray border | **Unchanged** - Step is identical in both versions |

### Layout

- **Left Column**: Current (Working Version) - your latest changes
- **Right Column**: Historical Version - the version you selected to compare against
- Steps are aligned row-by-row, with placeholders shown when a step exists only on one side
- Both columns scroll together for synchronized navigation
- The modal uses full screen width for maximum content visibility

## File Structure

```
sn-flow-compare/
├── manifest.json      # Extension configuration (Manifest V3)
├── background.js      # Service worker for extension events
├── content.js         # Main content script (DOM extraction, comparison logic)
├── styles.css         # UI styles for modal, overlay, and components
├── popup.html         # Extension popup interface
├── popup.js           # Popup script
├── README.md          # This file
└── icons/             # Extension icons
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

## Permissions

The extension requires the following permissions:

| Permission | Purpose |
|------------|---------|
| `activeTab` | Interact with the current ServiceNow tab |
| `storage` | Store extension preferences |
| `tabs` | Detect ServiceNow Flow Designer pages |
| `scripting` | Inject content scripts |
| `Host permissions` | Access to `*.service-now.com` and `*.servicenow.com` |

## Troubleshooting

### Extension not working on ServiceNow page

1. Make sure you're on a Flow Designer page (URL contains `/now/flow-designer/`)
2. Try refreshing the page after installing the extension
3. Check that the extension is enabled in `chrome://extensions/`
4. Ensure you have the required ServiceNow roles to view flows

### Steps not being captured correctly

1. Ensure the flow is fully loaded before triggering comparison
2. The extraction process opens each step one-by-one; allow it to complete
3. If steps appear empty, try clicking on each step manually first, then retry
4. Check the browser console (F12 > Console) for any error messages prefixed with `[SN Flow Compare]`

### Comparison not showing differences

1. Verify you've selected a different historical version (not the current one)
2. The versions may actually be identical if no changes were made
3. Changes to step order without content changes won't show as modified

### Keyboard shortcut doesn't work

1. Check `chrome://extensions/shortcuts` to ensure the shortcut is registered
2. The shortcut only works on ServiceNow pages
3. Some pages may capture the shortcut; try clicking in an empty area first

### Loading takes too long

1. Flows with many steps take longer as each step must be opened individually
2. The loading overlay shows progress; wait for it to complete
3. Complex steps with large configurations take more time to extract

## Requirements

- **Browser**: Chrome (or Chromium-based browsers like Edge, Brave)
- **ServiceNow**: Instance with Flow Designer
- **Permissions**: Access to view flows and flow versions

## Technical Notes

- Uses your existing ServiceNow session for authentication
- All data is processed client-side; nothing is sent to external servers
- Extracts step content from the DOM by programmatically clicking each step
- Shadow DOM is accessed for ServiceNow's web components where needed
- The extension automatically detects Flow Designer pages

## Browser Support

| Browser | Support |
|---------|---------|
| Chrome | Fully supported (Manifest V3) |
| Edge | Should work (Chromium-based) |
| Brave | Should work (Chromium-based) |
| Firefox | Not currently supported |

## License

MIT License - feel free to use, modify, and distribute.

## Changelog

### Version 1.0.0
- Initial release
- Side-by-side version comparison with row-based layout
- History sidebar integration for easy version selection
- Step-by-step extraction with loading overlay and progress
- Diff highlighting for added/removed/modified steps
- Full-width modal for maximum content visibility
- Synchronized scrolling between columns
- Matched step heights for visual alignment
