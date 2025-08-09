# FreePanes - Multi-Device Web Viewer

A high-performance Electron app for viewing websites across multiple device viewports simultaneously with synchronized scrolling.

## Features

- **Multiple Device Views**: View the same website on iPhone, iPad, desktop, and custom device sizes
- **Synchronized Scrolling**: Scroll one view and all others follow automatically
- **Modern UI**: Clean interface with dark/light mode support
- **Responsive Layout**: Automatically scales device views to fit your screen
- **Device Presets**: Includes popular devices (iPhone 15, iPad Pro, MacBook, etc.)
- **Navigation Controls**: Back, forward, reload buttons that work across all views
- **Easy Device Management**: Add/remove devices from the sidebar

## Getting Started

1. Install dependencies:
   ```bash
   npm install
   ```

2. Run the app:
   ```bash
   npm start
   ```

## Usage

1. Enter a URL in the address bar at the top
2. Select devices from the sidebar to add them to your view
3. All webviews will load the same URL and scroll in sync
4. Use navigation buttons to control all views simultaneously
5. Toggle theme with the moon icon
6. Toggle scroll sync with the button in the status bar

## Device Categories

- **Mobile**: iPhone 15 Pro/Plus, Samsung Galaxy S24, Google Pixel 8, etc.
- **Tablet**: iPad Mini/Air/Pro, Surface Pro
- **Desktop**: MacBook Air/Pro, 1080p/4K monitors
- **Custom**: Add your own device dimensions

## Keyboard Shortcuts

- `Enter` in URL bar: Navigate to URL
- `Cmd/Ctrl + R`: Reload all views
- `Cmd/Ctrl + Left/Right`: Navigate back/forward

## Technical Details

Built with Electron for cross-platform compatibility and high-performance webview rendering. Each device view is an independent webview that communicates scroll events for synchronization.

## Development

```bash
# Development mode (with DevTools)
npm run dev
```