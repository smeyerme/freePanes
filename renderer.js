// renderer.js - Simplified reliable version
const { ipcRenderer } = require("electron");
const fs = require("fs");
const path = require("path");

// Load devices and presets from JSON files
let devices = {};
let presets = {};

try {
  const devicesPath = path.join(__dirname, "devices.json");
  const presetsPath = path.join(__dirname, "presets.json");

  devices = JSON.parse(fs.readFileSync(devicesPath, "utf8"));
  presets = JSON.parse(fs.readFileSync(presetsPath, "utf8"));
} catch (error) {
  console.error("Error loading devices or presets:", error);
  // Fallback to hardcoded values if files can\'t be loaded
  devices = {
    "iPhone 14 Pro": { width: 393, height: 852 },
    "iPhone SE": { width: 375, height: 667 },
    "iPad Air": { width: 820, height: 1180 },
    "iPad Pro": { width: 1024, height: 1366 },
    "MacBook Air": { width: 1280, height: 800 },
    "Desktop HD": { width: 1920, height: 1080 },
  };

  presets = {
    responsive: ["iPhone 14 Pro", "iPad Air", "MacBook Air"],
    mobile: ["iPhone 14 Pro", "iPhone SE", "iPad Air"],
    desktop: ["MacBook Air", "Desktop HD"],
  };
}

let webviews = [];
let currentURL = "http://localhost:8080/";
let isScreenshotting = false; // Flag to prevent resize handler during screenshots
let recordedActions = [];
let deviceSpecificActions = {}; // Store actions per device name
let isRecording = false;
let customDeviceSelection = []; // For custom preset
let currentPreset = 'responsive';
let hideScrollbars = true; // Default to hiding scrollbars
let syncSettings = {
  scroll: true,
  navigation: true, // Sync URL/route changes
  click: true, // Sync clicks (smart mode)
  hover: false, // Disabled by default for performance
  input: false, // Disabled by default for SPA compatibility
};

function createViewport(deviceName) {
  const device = devices[deviceName];
  if (!device) {
    console.error(`Device '${deviceName}' not found. Available devices:`, Object.keys(devices));
    return document.createElement("div"); // Return empty div to prevent crashes
  }
  const scale = calculateScale(device);

  const viewportDiv = document.createElement("div");
  viewportDiv.className = "viewport";

  // Create header
  const header = document.createElement("div");
  header.className = "viewport-header";
  
  const deviceInfo = document.createElement("div");
  deviceInfo.style.display = "flex";
  deviceInfo.style.alignItems = "center";
  deviceInfo.innerHTML = `
    <span class="device-name">${deviceName}</span>
    <span class="device-size">${device.width} × ${device.height}</span>
  `;
  
  const devToolsBtn = document.createElement("button");
  devToolsBtn.className = "devtools-btn";
  devToolsBtn.innerHTML = '<svg class="icon icon-sm"><use href="#icon-tools"></use></svg>';
  devToolsBtn.title = "Open DevTools";
  devToolsBtn.onclick = () => toggleDevTools(webview, devToolsBtn);
  
  header.appendChild(deviceInfo);
  header.appendChild(devToolsBtn);
  viewportDiv.appendChild(header);

  // Create webview container at logical dimensions for proper mobile layout
  const container = document.createElement("div");
  container.className = "webview-container";
  container.style.width = device.width * scale + "px";
  container.style.height = device.height * scale + "px";
  container.style.position = "relative";
  
  // Only hide overflow if scrollbars are visible, otherwise allow scrolling
  if (hideScrollbars) {
    container.style.overflow = "auto"; // Allow scrolling when scrollbars are hidden
  } else {
    container.style.overflow = "hidden"; // Hide overflow when scrollbars are visible
  }

  // Create webview
  const webview = document.createElement("webview");
  webview.src = currentURL;

  // Set device scale factor for proper mobile/desktop layout detection
  const deviceScaleFactor = device.deviceScaleFactor || 1;

  // Set webview to logical dimensions (what website sees)
  webview.style.width = device.width + "px";
  webview.style.height = device.height + "px";
  webview.style.transform = `scale(${scale})`;
  webview.style.transformOrigin = "top left";
  webview.style.position = "absolute";
  webview.style.top = "0";
  webview.style.left = "0";

  // Use shared session for cookies/auth but not for JS state
  webview.partition = "persist:shared";
  webview.setAttribute("useragent", getUserAgent(deviceName));
  webview.setAttribute("minheight", device.height);

  // Set preferences without zoom factor (will be added dynamically for screenshots)
  const webPreferences = `allowRunningInsecureContent=true,deviceScaleFactor=${deviceScaleFactor},nodeIntegration=true,contextIsolation=false`;

  // Allow mixed content and disable some security for local dev
  webview.setAttribute("allowpopups", "true");
  webview.setAttribute("webpreferences", webPreferences);

  container.appendChild(webview);
  viewportDiv.appendChild(container);

  // Store device info and references for dynamic resizing
  webview.deviceInfo = device;
  webview.deviceName = deviceName;
  webview.containerElement = container;
  webview.devToolsButton = devToolsBtn;

  // Wait for DOM ready before injecting scripts
  webview.addEventListener("dom-ready", () => {
    // Apply scrollbar hiding FIRST if enabled (before sync scripts)
    if (hideScrollbars) {
      applyScrollbarHiding(webview);
    }
    
    // Then inject sync scripts after scrollbar CSS is applied
    if (syncSettings.scroll || syncSettings.hover || syncSettings.input) {
      // Small delay to ensure CSS is applied
      setTimeout(() => {
        setupWebviewSync(webview);
      }, 100);
    }
  });

  // Handle navigation changes
  webview.addEventListener("did-navigate", (e) => {
    document.getElementById("urlInput").value = e.url;
    if (syncSettings.navigation) {
      // Sync URL changes to other webviews
      syncNavigation(webview, e.url);
    }
  });

  // Handle in-page navigation (for SPAs)
  webview.addEventListener("did-navigate-in-page", (e) => {
    if (syncSettings.navigation && e.isMainFrame) {
      syncNavigation(webview, e.url);
    }
  });

  // Error handling
  webview.addEventListener("did-fail-load", (e) => {
    console.log(`Failed to load in ${deviceName}:`, e.errorDescription);
    // Don't propagate load errors to other views
  });

  // Handle DevTools state changes
  webview.addEventListener("devtools-opened", () => {
    if (webview.devToolsButton) {
      webview.devToolsButton.classList.add('active');
      webview.devToolsButton.title = 'Close DevTools';
    }
  });

  webview.addEventListener("devtools-closed", () => {
    if (webview.devToolsButton) {
      webview.devToolsButton.classList.remove('active');
      webview.devToolsButton.title = 'Open DevTools';
    }
  });

  webviews.push(webview);
  return viewportDiv;
}

function getUserAgent(deviceName) {
  if (deviceName.includes("iPhone")) {
    return "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1";
  } else if (deviceName.includes("iPad")) {
    return "Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1";
  }
  return navigator.userAgent;
}

function calculateScale(device) {
  const containerWidth = window.innerWidth - 80;
  const containerHeight = window.innerHeight - 200;
  const numDevices = 3;
  const targetWidth = containerWidth / numDevices - 30;
  const targetHeight = containerHeight - 50;

  const scaleX = targetWidth / device.width;
  const scaleY = targetHeight / device.height;

  return Math.min(scaleX, scaleY, 0.75);
}

function setupWebviewSync(webview) {
  // Enhanced sync script with recording functionality
  const syncScript = `
    (function() {
      // Clean up any existing event listeners to prevent duplicates
      if (window.syncCleanupFunctions) {
        window.syncCleanupFunctions.forEach(cleanup => cleanup());
      }
      window.syncCleanupFunctions = [];
      
      let isProcessingSync = false;
      let lastScrollTime = 0;
      let lastClickTime = 0;
      
      // Recording functionality
      window.recordedActions = window.recordedActions || [];
      window.isRecording = false;
      
      // Helper function to generate a reliable selector that works across viewports
      function generateSelector(element) {
        if (element.id) {
          return '#' + element.id;
        }
        
        // Try to find a unique class-based selector first
        if (element.className && typeof element.className === 'string') {
          const classes = element.className.trim().split(/\\s+/)
            .filter(c => c && !c.includes('active') && !c.includes('hover') && !c.includes('focus'));
          
          // Try single class selectors first
          for (const cls of classes) {
            const selector = '.' + cls;
            if (document.querySelectorAll(selector).length === 1) {
              return selector;
            }
          }
          
          // Try combinations of 2 classes
          if (classes.length >= 2) {
            const twoClassSelector = '.' + classes.slice(0, 2).join('.');
            if (document.querySelectorAll(twoClassSelector).length === 1) {
              return twoClassSelector;
            }
          }
        }
        
        // Build a shorter, more flexible path
        let path = [];
        let current = element;
        let maxDepth = 3; // Limit depth to avoid overly specific selectors
        
        while (current && current !== document.body && path.length < maxDepth) {
          let selector = current.tagName.toLowerCase();
          
          // Add classes but avoid nth-child when possible
          if (current.className && typeof current.className === 'string') {
            const stableClasses = current.className.trim().split(/\\s+/)
              .filter(c => c && 
                !c.includes('active') && 
                !c.includes('hover') && 
                !c.includes('focus') &&
                !c.includes('mobile') &&
                !c.includes('desktop') &&
                !c.includes('tablet'))
              .slice(0, 2);
            
            if (stableClasses.length > 0) {
              selector += '.' + stableClasses.join('.');
            }
          }
          
          // Only use nth-child if absolutely necessary and for small numbers
          const siblings = current.parentElement ? 
            Array.from(current.parentElement.children).filter(el => el.tagName === current.tagName) : [];
          
          if (siblings.length > 1 && siblings.length <= 3 && !selector.includes('.')) {
            const index = siblings.indexOf(current) + 1;
            selector += ':nth-child(' + index + ')';
          }
          
          path.unshift(selector);
          
          // Check if current selector is unique enough
          const currentPath = path.join(' > ');
          if (document.querySelectorAll(currentPath).length === 1) {
            return currentPath;
          }
          
          current = current.parentElement;
        }
        
        return path.join(' > ');
      }
      
      // Record clicks
      const recordClickHandler = function(e) {
        if (window.isRecording && !isProcessingSync) {
          const action = {
            type: 'click',
            selector: generateSelector(e.target),
            coordinates: { 
              x: e.clientX, 
              y: e.clientY 
            },
            timestamp: Date.now(),
            tagName: e.target.tagName,
            text: e.target.textContent ? e.target.textContent.substring(0, 50) : ''
          };
          
          window.recordedActions.push(action);
          console.log('RECORD:CLICK:', JSON.stringify(action));
        }
      };
      
      document.addEventListener('click', recordClickHandler, true);
      
      // Store cleanup function
      window.syncCleanupFunctions.push(() => {
        document.removeEventListener('click', recordClickHandler, true);
      });
      
      // Record input changes
      const recordInputHandler = function(e) {
        if (window.isRecording && !isProcessingSync) {
          const action = {
            type: 'input',
            selector: generateSelector(e.target),
            value: e.target.value,
            timestamp: Date.now()
          };
          
          window.recordedActions.push(action);
          console.log('RECORD:INPUT:', JSON.stringify(action));
        }
      };
      
      document.addEventListener('input', recordInputHandler, true);
      
      // Store cleanup function
      window.syncCleanupFunctions.push(() => {
        document.removeEventListener('input', recordInputHandler, true);
      });
      
      // Record scrolling (throttled)
      let scrollTimeout = null;
      const recordScrollHandler = function(e) {
        if (window.isRecording && !isProcessingSync) {
          clearTimeout(scrollTimeout);
          scrollTimeout = setTimeout(() => {
            const action = {
              type: 'scroll',
              x: window.scrollX,
              y: window.scrollY,
              timestamp: Date.now()
            };
            
            window.recordedActions.push(action);
            console.log('RECORD:SCROLL:', JSON.stringify(action));
          }, 150);
        }
      };
      
      window.addEventListener('scroll', recordScrollHandler, { passive: true });
      
      // Store cleanup function
      window.syncCleanupFunctions.push(() => {
        window.removeEventListener('scroll', recordScrollHandler, { passive: true });
      });
      
      // Global functions for controlling recording
      window.startRecording = function() {
        window.isRecording = true;
        window.recordedActions = [];
        console.log('Started recording interactions...');
      };
      
      window.stopRecording = function() {
        window.isRecording = false;
        console.log('Stopped recording. Captured', window.recordedActions.length, 'actions');
        return window.recordedActions;
      };
      
      window.getRecordedActions = function() {
        return window.recordedActions;
      };
      
      // Only sync scroll - the most reliable sync
      if (${syncSettings.scroll}) {
        console.log('Setting up scroll sync listener...');
        
        const scrollHandler = function() {
          if (isProcessingSync) return;
          
          const now = Date.now();
          if (now - lastScrollTime < 50) return; // Throttle
          lastScrollTime = now;
          
          const data = {
            percentX: window.scrollX / Math.max(1, document.documentElement.scrollWidth - window.innerWidth),
            percentY: window.scrollY / Math.max(1, document.documentElement.scrollHeight - window.innerHeight)
          };
          
          console.log('SYNC:SCROLL:' + JSON.stringify(data));
        };
        
        window.addEventListener('scroll', scrollHandler, { passive: true });
        
        // Store cleanup function
        window.syncCleanupFunctions.push(() => {
          window.removeEventListener('scroll', scrollHandler, { passive: true });
        });
        
        // Test scroll capability
        console.log('Scroll dimensions - Width:', document.documentElement.scrollWidth, 'Height:', document.documentElement.scrollHeight);
        console.log('Viewport dimensions - Width:', window.innerWidth, 'Height:', window.innerHeight);
      }
      
      // Smart click sync
      if (${syncSettings.click}) {
        const syncClickHandler = function(e) {
          if (isProcessingSync) return;
          
          const now = Date.now();
          if (now - lastClickTime < 100) return; // Prevent double clicks
          lastClickTime = now;
          
          const target = e.target;
          
          // Build a reliable selector
          let selector = '';
          let element = target;
          const path = [];
          
          while (element && element !== document.body) {
            let sel = element.nodeName.toLowerCase();
            
            // Prefer ID
            if (element.id) {
              sel = '#' + element.id;
              path.unshift(sel);
              break;
            }
            
            // Use classes (but filter out dynamic ones)
            if (element.className && typeof element.className === 'string') {
              const classes = element.className
                .split(' ')
                .filter(c => c && !c.includes('active') && !c.includes('hover') && !c.includes('focus'))
                .slice(0, 2)
                .join('.');
              if (classes) sel += '.' + classes;
            }
            
            // Add position among siblings
            if (element.parentElement) {
              const siblings = Array.from(element.parentElement.children);
              const index = siblings.indexOf(element);
              sel += ':nth-child(' + (index + 1) + ')';
            }
            
            path.unshift(sel);
            element = element.parentElement;
          }
          
          selector = path.join(' > ');
          
          // Get click coordinates relative to viewport
          const rect = target.getBoundingClientRect();
          
          console.log('SYNC:CLICK:' + JSON.stringify({
            selector: selector,
            x: rect.x + rect.width / 2,
            y: rect.y + rect.height / 2,
            tagName: target.tagName,
            href: target.href || null,
            text: target.textContent ? target.textContent.substring(0, 30) : ''
          }));
        };
        
        document.addEventListener('click', syncClickHandler, true);
        
        // Store cleanup function
        window.syncCleanupFunctions.push(() => {
          document.removeEventListener('click', syncClickHandler, true);
        });
      }
      
      // Element-based hover tracking if enabled
      if (${syncSettings.hover}) {
        let hoverTimer = null;
        let lastHoveredElement = null;
        
        const hoverOverHandler = function(e) {
          if (isProcessingSync) return;
          
          const target = e.target;
          if (target === lastHoveredElement) return; // Same element, skip
          
          lastHoveredElement = target;
          
          clearTimeout(hoverTimer);
          hoverTimer = setTimeout(() => {
            // Generate selector for the hovered element
            const selector = generateSelector(target);
            if (selector) {
              console.log('SYNC:HOVER:' + JSON.stringify({ 
                selector: selector,
                tagName: target.tagName,
                className: target.className,
                textContent: target.textContent ? target.textContent.substring(0, 30) : ''
              }));
            }
          }, 200); // Increased throttle for better reliability
        };
        
        const hoverOutHandler = function(e) {
          if (isProcessingSync) return;
          if (e.target === lastHoveredElement) {
            lastHoveredElement = null;
          }
        };
        
        document.addEventListener('mouseover', hoverOverHandler, { passive: true });
        document.addEventListener('mouseout', hoverOutHandler, { passive: true });
        
        // Store cleanup functions
        window.syncCleanupFunctions.push(() => {
          document.removeEventListener('mouseover', hoverOverHandler, { passive: true });
          document.removeEventListener('mouseout', hoverOutHandler, { passive: true });
        });
      }
      
      // Minimal input sync if enabled
      if (${syncSettings.input}) {
        let inputTimer = null;
        
        const syncInputHandler = function(e) {
          if (isProcessingSync) return;
          
          const el = e.target;
          if (el.id && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
            clearTimeout(inputTimer);
            inputTimer = setTimeout(() => {
              console.log('SYNC:INPUT:' + JSON.stringify({
                id: el.id,
                value: el.value
              }));
            }, 500);
          }
        };
        
        document.addEventListener('input', syncInputHandler, true);
        
        // Store cleanup function
        window.syncCleanupFunctions.push(() => {
          document.removeEventListener('input', syncInputHandler, true);
        });
      }
      
      // Apply sync function
      window.applySyncAction = function(type, data) {
        isProcessingSync = true;
        
        requestAnimationFrame(() => {
          try {
            if (type === 'scroll' && data.percentX !== undefined) {
              const maxX = document.documentElement.scrollWidth - window.innerWidth;
              const maxY = document.documentElement.scrollHeight - window.innerHeight;
              window.scrollTo({
                left: data.percentX * maxX,
                top: data.percentY * maxY,
                behavior: 'instant'
              });
            } else if (type === 'click' && data.selector) {
              // Try to find and click the element
              try {
                const element = document.querySelector(data.selector);
                if (element) {
                  // Create and dispatch a click event
                  const evt = new MouseEvent('click', {
                    view: window,
                    bubbles: true,
                    cancelable: true,
                    clientX: data.x || 0,
                    clientY: data.y || 0
                  });
                  element.dispatchEvent(evt);
                }
              } catch (e) {
                // If selector fails, try simpler approach
                console.log('Click sync failed for selector:', data.selector);
              }
            } else if (type === 'hover' && data.selector) {
              try {
                const el = document.querySelector(data.selector);
                if (el) {
                  // Dispatch mouseover event to simulate hover
                  el.dispatchEvent(new MouseEvent('mouseover', { 
                    bubbles: true,
                    cancelable: true 
                  }));
                  
                  // Also dispatch mouseenter for compatibility
                  el.dispatchEvent(new MouseEvent('mouseenter', { 
                    bubbles: true,
                    cancelable: true 
                  }));
                }
              } catch (e) {
                console.warn('SYNC:HOVER: Could not find element with selector:', data.selector);
              }
            } else if (type === 'input' && data.id) {
              const el = document.getElementById(data.id);
              if (el) {
                el.value = data.value;
                el.dispatchEvent(new Event('input', { bubbles: true }));
              }
            }
          } catch (e) {
            // Silently ignore errors
          }
          
          setTimeout(() => { isProcessingSync = false; }, 50);
        });
      };
      
      console.log('Sync initialized with click support');
    })();
  `;

  // Inject with error handling
  webview.executeJavaScript(syncScript, false).catch((err) => {
    console.log(`Sync script injection skipped for ${webview.deviceName}`);
  });

  // Track last recorded action to prevent duplicates
  webview.lastRecordedAction = { time: 0, type: '', data: '' };
  
  // Listen for sync messages
  webview.addEventListener("console-message", (e) => {
    if (!e.message.startsWith("SYNC:") && !e.message.startsWith("RECORD:")) return;

    try {
      if (e.message.startsWith("SYNC:SCROLL:") && syncSettings.scroll) {
        const data = JSON.parse(e.message.replace("SYNC:SCROLL:", ""));
        syncToOtherWebviews(webview, "scroll", data);
      } else if (e.message.startsWith("SYNC:CLICK:") && syncSettings.click) {
        const data = JSON.parse(e.message.replace("SYNC:CLICK:", ""));
        syncToOtherWebviews(webview, "click", data);
        // Record this click for the SOURCE device (only through SYNC, not RECORD)
        if (isRecording) {
          // Check for duplicate within 100ms
          const now = Date.now();
          const isDuplicate = webview.lastRecordedAction.type === 'click' && 
                            (now - webview.lastRecordedAction.time) < 100;
          
          if (!isDuplicate) {
            storeDeviceSpecificAction(webview, "click", data);
            webview.lastRecordedAction = { time: now, type: 'click', data: JSON.stringify(data) };
          }
        }
      } else if (e.message.startsWith("SYNC:HOVER:") && syncSettings.hover) {
        const data = JSON.parse(e.message.replace("SYNC:HOVER:", ""));
        syncToOtherWebviews(webview, "hover", data);
      } else if (e.message.startsWith("SYNC:INPUT:") && syncSettings.input) {
        const data = JSON.parse(e.message.replace("SYNC:INPUT:", ""));
        syncToOtherWebviews(webview, "input", data);
        if (isRecording) {
          const now = Date.now();
          const isDuplicate = webview.lastRecordedAction.type === 'input' && 
                            (now - webview.lastRecordedAction.time) < 100;
          
          if (!isDuplicate) {
            storeDeviceSpecificAction(webview, "input", data);
            webview.lastRecordedAction = { time: now, type: 'input', data: JSON.stringify(data) };
          }
        }
      } else if (e.message.startsWith("RECORD:") && isRecording) {
        // Skip RECORD messages - we're using SYNC messages for recording
        // This prevents duplicates since both RECORD and SYNC fire for the same action
      }
    } catch (err) {
      // Ignore parse errors
    }
  });
}

function storeDeviceSpecificAction(webview, type, data) {
  const deviceName = webview.deviceName;
  if (!deviceName) return;
  
  // Initialize device-specific actions array if needed
  if (!deviceSpecificActions[deviceName]) {
    deviceSpecificActions[deviceName] = [];
  }
  
  // Store the action with device context
  const actionWithDevice = {
    ...data,
    type: type,
    deviceName: deviceName,
    timestamp: Date.now(),
    viewport: {
      width: webview.deviceInfo?.width || 375,
      height: webview.deviceInfo?.height || 667,
      deviceScaleFactor: webview.deviceInfo?.deviceScaleFactor || 1
    }
  };
  
  deviceSpecificActions[deviceName].push(actionWithDevice);
  console.log(`Action recorded for ${deviceName}:`, actionWithDevice);
}

function syncToOtherWebviews(sourceWebview, type, data) {
  webviews.forEach((webview) => {
    if (webview !== sourceWebview && webview.getURL()) {
      const script = `
        if (typeof window.applySyncAction === 'function') {
          window.applySyncAction('${type}', ${JSON.stringify(data)});
        }
      `;

      webview.executeJavaScript(script, false).then(() => {
        // If recording, store this synced action for the target device
        if (isRecording && (type === 'click' || type === 'input')) {
          // Check for duplicate to prevent recording the same synced action multiple times
          const now = Date.now();
          const isDuplicate = webview.lastRecordedAction && 
                            webview.lastRecordedAction.type === type && 
                            (now - webview.lastRecordedAction.time) < 100;
          
          if (!isDuplicate) {
            storeDeviceSpecificAction(webview, type, data);
            if (!webview.lastRecordedAction) {
              webview.lastRecordedAction = {};
            }
            webview.lastRecordedAction = { time: now, type: type, data: JSON.stringify(data) };
          }
        }
      }).catch(() => {
        // Silently ignore if webview not ready
      });
    }
  });
}

function syncNavigation(sourceWebview, url) {
  webviews.forEach((webview) => {
    if (webview !== sourceWebview) {
      // Only sync if URLs are different
      if (webview.getURL() !== url) {
        webview.loadURL(url);
      }
    }
  });
}

function loadURL() {
  const input = document.getElementById("urlInput");
  currentURL = input.value.trim();

  // Add protocol if missing
  if (!currentURL.startsWith("http://") && !currentURL.startsWith("https://")) {
    currentURL = "https://" + currentURL;
  }

  // Update input with full URL
  input.value = currentURL;

  // Save to history
  saveToHistory(currentURL);

  // Load in all webviews
  webviews.forEach((webview) => {
    webview.loadURL(currentURL);
  });
}

function reloadAll() {
  webviews.forEach((webview) => {
    webview.reload();
  });
}

// Internal loadPreset function
function loadPresetInternal(presetName, buttonElement) {
  const container = document.getElementById("viewportsContainer");
  container.innerHTML = "";
  webviews = [];

  const deviceList = presets[presetName];
  if (!deviceList) {
    console.error(`Preset '${presetName}' not found. Available presets:`, Object.keys(presets));
    alert(`Preset '${presetName}' not found. Using default responsive preset.`);
    loadPresetInternal("responsive", buttonElement);
    return;
  }

  deviceList.forEach((deviceName) => {
    const viewport = createViewport(deviceName);
    container.appendChild(viewport);
  });

  document.getElementById("deviceCount").textContent =
    deviceList.length + " devices";

  // Update active preset button
  document.querySelectorAll(".device-preset").forEach((btn) => {
    btn.classList.remove("active");
  });

  if (buttonElement) {
    buttonElement.classList.add("active");
  } else {
    document.querySelectorAll(".device-preset").forEach((btn) => {
      if (btn.textContent.toLowerCase() === presetName) {
        btn.classList.add("active");
      }
    });
  }
}

// Global functions for HTML onclick handlers
window.loadPreset = function (presetName) {
  const buttonElement =
    typeof event !== "undefined" && event.target ? event.target : null;
  loadPresetInternal(presetName, buttonElement);
};

window.loadURL = loadURL;
window.reloadAll = reloadAll;

// Apply scrollbar hiding to a webview
function applyScrollbarHiding(webview) {
  const hideScrollbarsCSS = `
    /* Hide scrollbars while maintaining scroll functionality */
    ::-webkit-scrollbar {
      width: 0px !important;
      height: 0px !important;
      background: transparent !important;
    }
    
    /* For Firefox */
    * {
      scrollbar-width: none !important;
    }
    
    /* Ensure overflow is still scrollable */
    html, body {
      overflow: auto !important;
    }
  `;

  webview.executeJavaScript(`
    (function() {
      // Remove any existing scrollbar styles
      const existingStyle = document.getElementById('hide-scrollbars-style');
      if (existingStyle) {
        existingStyle.remove();
      }
      
      // Add new scrollbar hiding styles
      const style = document.createElement('style');
      style.id = 'hide-scrollbars-style';
      style.textContent = \`${hideScrollbarsCSS}\`;
      document.head.appendChild(style);
      
      console.log('Scrollbars hidden');
    })();
  `).catch(err => {
    console.log(`Failed to hide scrollbars for ${webview.deviceName}:`, err);
  });
}

// Remove scrollbar hiding from a webview
function removeScrollbarHiding(webview) {
  webview.executeJavaScript(`
    (function() {
      const existingStyle = document.getElementById('hide-scrollbars-style');
      if (existingStyle) {
        existingStyle.remove();
        console.log('Scrollbars restored');
      }
    })();
  `).catch(err => {
    console.log(`Failed to restore scrollbars for ${webview.deviceName}:`, err);
  });
}

// Update scroll sync state based on scrollbar visibility
function updateScrollSyncState() {
  const scrollToggle = document.getElementById("syncScroll");
  if (scrollToggle) {
    if (hideScrollbars) {
      // Disable scroll sync when scrollbars are hidden
      scrollToggle.style.opacity = "0.5";
      scrollToggle.style.pointerEvents = "none";
      scrollToggle.classList.remove("active");
      scrollToggle.querySelector("input").checked = false;
      syncSettings.scroll = false;
      
      // Add a tooltip or visual indicator
      scrollToggle.setAttribute("title", "Scroll sync disabled when scrollbars are hidden");
    } else {
      // Enable scroll sync when scrollbars are visible
      scrollToggle.style.opacity = "1";
      scrollToggle.style.pointerEvents = "auto";
      scrollToggle.classList.add("active");
      scrollToggle.querySelector("input").checked = true;
      syncSettings.scroll = true;
      
      // Remove tooltip
      scrollToggle.removeAttribute("title");
    }
  }
}

// Apply scrollbar setting to all webviews
function updateScrollbarVisibility() {
  webviews.forEach(webview => {
    if (webview.getURL() && webview.getURL() !== "about:blank") {
      if (hideScrollbars) {
        applyScrollbarHiding(webview);
        // Allow container scrolling when scrollbars are hidden
        webview.containerElement.style.overflow = "auto";
      } else {
        removeScrollbarHiding(webview);
        // Hide container overflow when scrollbars are visible  
        webview.containerElement.style.overflow = "hidden";
      }
      
      // Reinject sync scripts after scrollbar changes to ensure scroll events work
      if (syncSettings.scroll || syncSettings.hover || syncSettings.input) {
        setTimeout(() => {
          setupWebviewSync(webview);
        }, 150); // Slightly longer delay to ensure CSS changes are applied
      }
    }
  });
}

// Toggle DevTools for a specific webview
function toggleDevTools(webview, button) {
  try {
    if (webview.isDevToolsOpened()) {
      webview.closeDevTools();
      button.classList.remove('active');
      button.title = 'Open DevTools';
      console.log(`DevTools closed for ${webview.deviceName}`);
    } else {
      webview.openDevTools();
      button.classList.add('active');
      button.title = 'Close DevTools';
      console.log(`DevTools opened for ${webview.deviceName}`);
    }
  } catch (error) {
    console.error(`Failed to toggle DevTools for ${webview.deviceName}:`, error);
    
    // Fallback: try to open DevTools even if state check failed
    try {
      webview.openDevTools();
      button.classList.add('active');
      button.title = 'Close DevTools';
    } catch (fallbackError) {
      console.error(`Fallback DevTools open also failed:`, fallbackError);
      alert(`Failed to open DevTools for ${webview.deviceName}`);
    }
  }
}

// Setup sync toggles
function setupSyncToggles() {
  // Scroll sync
  const scrollToggle = document.getElementById("syncScroll");
  if (scrollToggle) {
    scrollToggle.addEventListener("click", function (e) {
      e.preventDefault();
      const checkbox = this.querySelector("input");
      const isActive = this.classList.contains("active");
      
      // Toggle state
      checkbox.checked = !isActive;
      this.classList.toggle("active");
      syncSettings.scroll = !isActive;
      reinjectSyncScripts();
    });
  }

  // Navigation sync
  const navToggle = document.getElementById("syncNavigation");
  if (navToggle) {
    navToggle.addEventListener("click", function (e) {
      e.preventDefault();
      const checkbox = this.querySelector("input");
      const isActive = this.classList.contains("active");
      
      checkbox.checked = !isActive;
      this.classList.toggle("active");
      syncSettings.navigation = !isActive;
    });
  }

  // Click sync
  const clickToggle = document.getElementById("syncClick");
  if (clickToggle) {
    clickToggle.addEventListener("click", function (e) {
      e.preventDefault();
      const checkbox = this.querySelector("input");
      const isActive = this.classList.contains("active");
      
      checkbox.checked = !isActive;
      this.classList.toggle("active");
      syncSettings.click = !isActive;
      reinjectSyncScripts();
    });
  }

  // Hover sync (disabled by default)
  const hoverToggle = document.getElementById("syncHover");
  if (hoverToggle) {
    hoverToggle.addEventListener("click", function (e) {
      e.preventDefault();
      const checkbox = this.querySelector("input");
      const isActive = this.classList.contains("active");
      
      checkbox.checked = !isActive;
      this.classList.toggle("active");
      syncSettings.hover = !isActive;
      reinjectSyncScripts();
    });
  }

  // Input sync (disabled by default)
  const inputToggle = document.getElementById("syncInput");
  if (inputToggle) {
    inputToggle.addEventListener("click", function (e) {
      e.preventDefault();
      const checkbox = this.querySelector("input");
      const isActive = this.classList.contains("active");
      
      checkbox.checked = !isActive;
      this.classList.toggle("active");
      syncSettings.input = !isActive;
      reinjectSyncScripts();
    });
  }

  // Hide scrollbars toggle (enabled by default)
  const scrollbarsToggle = document.getElementById("hideScrollbars");
  if (scrollbarsToggle) {
    scrollbarsToggle.addEventListener("click", function (e) {
      e.preventDefault();
      const checkbox = this.querySelector("input");
      const isActive = this.classList.contains("active");
      
      checkbox.checked = !isActive;
      this.classList.toggle("active");
      hideScrollbars = !isActive;
      
      // Update scroll sync availability based on scrollbar visibility
      updateScrollSyncState();
      updateScrollbarVisibility();
    });
  }
}

function reinjectSyncScripts() {
  // Re-inject sync scripts with updated settings
  webviews.forEach((webview) => {
    if (webview.getURL() && webview.getURL() !== "about:blank") {
      setupWebviewSync(webview);
    }
  });
}

// Handle Enter key
function setupKeyboardShortcuts() {
  document.getElementById("urlInput").addEventListener("keypress", (e) => {
    if (e.key === "Enter") loadURL();
  });
}

// Window resize handler
function setupResizeHandler() {
  let resizeTimer;
  window.addEventListener("resize", () => {
    // Don't reload preset during screenshot capture
    if (isScreenshotting) {
      return;
    }
    
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const activeButton = document.querySelector(".device-preset.active");
      if (activeButton) {
        const presetName = activeButton.textContent.toLowerCase();
        loadPresetInternal(presetName, activeButton);
      }
    }, 250);
  });
}

// Initialize everything when DOM is ready
document.addEventListener("DOMContentLoaded", () => {
  setupSyncToggles();
  setupKeyboardShortcuts();
  setupResizeHandler();
  
  // Set initial scroll sync state based on scrollbar visibility
  updateScrollSyncState();
  
  // Populate device list in sidebar
  populateDeviceList();
  
  // Hide custom preset controls initially
  document.getElementById('customPresetControls').classList.add('hidden');

  // Load default preset
  loadPresetInternal("responsive");
});

// URL History Management
let urlHistory = JSON.parse(localStorage.getItem("urlHistory") || "[]");

function saveToHistory(url) {
  // Remove if already exists to avoid duplicates
  urlHistory = urlHistory.filter((item) => item !== url);
  // Add to beginning of array
  urlHistory.unshift(url);
  // Limit to 20 items
  urlHistory = urlHistory.slice(0, 20);
  // Save to localStorage
  localStorage.setItem("urlHistory", JSON.stringify(urlHistory));
}

function toggleHistory() {
  const historyDiv = document.getElementById("urlHistory");
  const isVisible = historyDiv.style.display !== "none";

  if (isVisible) {
    historyDiv.style.display = "none";
  } else {
    // Populate history
    historyDiv.innerHTML = "";
    if (urlHistory.length === 0) {
      historyDiv.innerHTML =
        '<div style="padding: 10px; color: #888; font-size: 12px;">No history yet</div>';
    } else {
      urlHistory.forEach((url) => {
        const item = document.createElement("div");
        item.style.cssText =
          "padding: 8px 12px; cursor: pointer; font-size: 13px; border-bottom: 1px solid #444;";
        item.textContent = url;
        item.onclick = () => {
          document.getElementById("urlInput").value = url;
          loadURL();
          historyDiv.style.display = "none";
        };
        item.onmouseover = () => (item.style.background = "#3a3a3a");
        item.onmouseout = () => (item.style.background = "transparent");
        historyDiv.appendChild(item);
      });
    }
    historyDiv.style.display = "block";
  }
}

// Close history when clicking outside
document.addEventListener("click", (e) => {
  const historyDiv = document.getElementById("urlHistory");
  const historyBtn = document.getElementById("historyBtn");
  const urlInput = document.getElementById("urlInput");

  if (
    !historyDiv.contains(e.target) &&
    e.target !== historyBtn &&
    e.target !== urlInput
  ) {
    historyDiv.style.display = "none";
  }
});

// Screenshot All Functionality
async function screenshotAll() {
  console.log("Screenshot function called, webviews count:", webviews.length);
  
  if (webviews.length === 0) {
    alert("No webviews to screenshot!");
    return;
  }

  const button = document.querySelector('button[onclick="screenshotAll()"]');
  const originalHTML = button.innerHTML;
  button.innerHTML = '<svg class="icon"><use href="#icon-camera"></use></svg>Taking Screenshots...';
  button.disabled = true;
  
  // Set flag to prevent resize handler from reloading presets
  isScreenshotting = true;

  try {
    const { ipcRenderer } = require("electron");
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

    // Create screenshots directory if it doesn't exist
    const screenshotsDir = require("path").join(process.cwd(), "screenshots");
    const fs = require("fs");
    
    console.log("Screenshots directory:", screenshotsDir);

    if (!fs.existsSync(screenshotsDir)) {
      console.log("Creating screenshots directory...");
      fs.mkdirSync(screenshotsDir);
    }

    let successCount = 0;
    const totalCount = webviews.length;

    // Take screenshot of each webview
    for (let i = 0; i < webviews.length; i++) {
      const webview = webviews[i];
      const deviceName = webview.deviceName ? webview.deviceName.replace(/[^a-zA-Z0-9]/g, "_") : `device_${i}`;
      
      console.log(`Processing webview ${i + 1}/${totalCount}: ${deviceName}`);

      try {
        // Get device info
        const deviceScaleFactor = webview.deviceInfo?.deviceScaleFactor || 1;
        const logicalWidth = webview.deviceInfo?.width || 375;
        const logicalHeight = webview.deviceInfo?.height || 667;
        const physicalWidth = logicalWidth * deviceScaleFactor;
        const physicalHeight = logicalHeight * deviceScaleFactor;
        
        const currentURL = webview.getURL();
        console.log(`  URL: ${currentURL}`);
        console.log(`  Device scale factor: ${deviceScaleFactor}`);
        console.log(`  Dimensions: ${logicalWidth}x${logicalHeight} (logical), ${physicalWidth}x${physicalHeight} (physical)`);

        let buffer;

        // Playwright-based capture in separate browser (doesn't touch existing webviews)
        try {
          console.log(`  Opening separate Playwright browser for ${deviceName}...`);
          console.log(`  → Viewport: ${logicalWidth}x${logicalHeight} @ ${deviceScaleFactor}x DPI`);
          console.log(`  → Final image will be: ${physicalWidth}x${physicalHeight} pixels`);
          
          // Extract localStorage and indexedDB from the current webview
          console.log(`  Extracting app state from webview...`);
          let appState = null;
          
          try {
            appState = await webview.executeJavaScript(`
              (async function() {
                const state = {
                  localStorage: {},
                  sessionStorage: {},
                  indexedDB: {}
                };
                
                // Extract localStorage
                for (let i = 0; i < localStorage.length; i++) {
                  const key = localStorage.key(i);
                  state.localStorage[key] = localStorage.getItem(key);
                }
                
                // Extract sessionStorage
                for (let i = 0; i < sessionStorage.length; i++) {
                  const key = sessionStorage.key(i);
                  state.sessionStorage[key] = sessionStorage.getItem(key);
                }
                
                // Extract indexedDB (basic approach - gets all databases)
                try {
                  const databases = await indexedDB.databases();
                  for (const dbInfo of databases) {
                    if (dbInfo.name) {
                      // We'll just store the database info for now
                      // Full indexedDB extraction would be more complex
                      state.indexedDB[dbInfo.name] = {
                        name: dbInfo.name,
                        version: dbInfo.version
                      };
                    }
                  }
                } catch (e) {
                  console.log('IndexedDB extraction skipped:', e.message);
                }
                
                return state;
              })()
            `);
            
            console.log(`  Extracted state:`, Object.keys(appState.localStorage).length, 'localStorage items,', 
                       Object.keys(appState.sessionStorage).length, 'sessionStorage items,',
                       Object.keys(appState.indexedDB).length, 'indexedDB databases');
          } catch (stateError) {
            console.warn(`  Failed to extract app state:`, stateError);
            appState = null;
          }
          
          // Use Playwright in completely separate browser - webviews stay untouched
          buffer = await ipcRenderer.invoke('capture-playwright-screenshot', {
            url: currentURL,
            width: logicalWidth,
            height: logicalHeight, 
            deviceScaleFactor: deviceScaleFactor,
            userAgent: webview.getAttribute('useragent'),
            appState: appState
          });
          
          console.log(`  ✅ Separate browser capture successful (${buffer.length} bytes)`);
          
        } catch (error) {
          console.error(`  Separate browser capture failed:`, error);
          console.log(`  Note: This should not affect the existing webviews which remain untouched`);
          throw error;
        }

        const dpiSuffix = deviceScaleFactor > 1 ? `_${deviceScaleFactor}x` : "";
        const filename = `screenshot_${timestamp}_${deviceName}${dpiSuffix}.png`;
        const filepath = require("path").join(screenshotsDir, filename);

        console.log(`  Writing to file: ${filepath}`);
        fs.writeFileSync(filepath, buffer);
        successCount++;

        console.log(`  ✅ Screenshot saved: ${filepath}`);
        console.log(
          `    Logical: ${logicalWidth}x${logicalHeight} (website sees this)`
        );
        console.log(
          `    Physical: ${physicalWidth}x${physicalHeight} (screenshot target)`
        );
        console.log(`    Scale: ${deviceScaleFactor}x`);
      } catch (error) {
        console.error(`Failed to screenshot ${deviceName}:`, error);
        console.error(`  Error details:`, error.stack);
      }
    }

    console.log(`Screenshot process complete: ${successCount}/${totalCount} successful`);
    alert(
      `Screenshots complete! Saved ${successCount}/${totalCount} screenshots to /screenshots folder`
    );
    // Reset UI to default
    setUIMode('default');
  } catch (error) {
    console.error("Screenshot error:", error);
    console.error("Error stack:", error.stack);
    alert(`Failed to take screenshots: ${error.message}\n\nCheck DevTools console for details.`);
  } finally {
    // Reset flag
    isScreenshotting = false;
    button.innerHTML = originalHTML;
    button.disabled = false;
  }
}

// UI state management
function setUIMode(mode) {
  // Hide all buttons first
  const allButtons = ['manualModeBtn', 'screenshotAllBtn', 'triggerScreenshotBtn', 
                       'stopBtn', 'screenshotWithReplayBtn', 'cancelBtn'];
  const advancedDropdown = document.querySelector('.advanced-capture-dropdown');
  
  allButtons.forEach(id => {
    const btn = document.getElementById(id);
    if (btn) btn.classList.add('hidden');
  });
  
  // Show buttons based on mode
  switch(mode) {
    case 'default':
      document.getElementById('manualModeBtn').classList.remove('hidden');
      document.getElementById('screenshotAllBtn').classList.remove('hidden');
      advancedDropdown.style.display = 'inline-block';
      break;
    case 'manual':
      document.getElementById('triggerScreenshotBtn').classList.remove('hidden');
      document.getElementById('cancelBtn').classList.remove('hidden');
      advancedDropdown.style.display = 'none';
      break;
    case 'recording':
      document.getElementById('stopBtn').classList.remove('hidden');
      document.getElementById('cancelBtn').classList.remove('hidden');
      advancedDropdown.style.display = 'none';
      break;
    case 'replay':
      document.getElementById('screenshotWithReplayBtn').classList.remove('hidden');
      document.getElementById('cancelBtn').classList.remove('hidden');
      advancedDropdown.style.display = 'none';
      break;
  }
  
  // Close advanced capture menu if open
  const advancedMenu = document.getElementById('advancedCaptureMenu');
  const advancedToggle = document.querySelector('.advanced-capture-toggle');
  if (advancedMenu) advancedMenu.classList.remove('open');
  if (advancedToggle) advancedToggle.classList.remove('open');
}

// Recording control functions
window.startRecording = function() {
  console.log('Starting device-specific recording across all webviews...');
  isRecording = true;
  recordedActions = [];
  deviceSpecificActions = {}; // Reset device-specific actions
  
  // Start recording in all webviews
  webviews.forEach((webview, index) => {
    try {
      webview.executeJavaScript('window.startRecording && window.startRecording();');
      console.log(`Started recording in webview ${index} (${webview.deviceName})`);
    } catch (e) {
      console.warn(`Failed to start recording in webview ${index}:`, e);
    }
  });
  
  // Update UI to recording mode
  setUIMode('recording');
};

window.stopRecording = async function() {
  console.log('Stopping device-specific recording...');
  isRecording = false;
  
  // Stop recording in all webviews
  webviews.forEach((webview, index) => {
    try {
      webview.executeJavaScript('window.stopRecording && window.stopRecording();');
    } catch (e) {
      console.warn(`Failed to stop recording in webview ${index}:`, e);
    }
  });
  
  // Count total actions across all devices
  let totalActions = 0;
  const deviceSummary = [];
  
  Object.keys(deviceSpecificActions).forEach(deviceName => {
    const actions = deviceSpecificActions[deviceName];
    totalActions += actions.length;
    deviceSummary.push(`${deviceName}: ${actions.length} actions`);
  });
  
  console.log('Device-specific recording complete:');
  console.log('  Total actions:', totalActions);
  console.log('  Per device:', deviceSpecificActions);
  
  // Update UI to replay mode if we have actions
  if (totalActions > 0) {
    setUIMode('replay');
  } else {
    setUIMode('default');
  }
  
  const summaryText = deviceSummary.length > 0 ? `\n\nPer device:\n${deviceSummary.join('\n')}` : '';
  alert(`Device-specific recording stopped! Captured ${totalActions} total actions across ${Object.keys(deviceSpecificActions).length} devices.${summaryText}`);
};

window.screenshotAllWithReplay = async function() {
  console.log('Taking screenshots with device-specific replay...');
  
  const totalDeviceActions = Object.keys(deviceSpecificActions).reduce((sum, device) => 
    sum + deviceSpecificActions[device].length, 0);
  
  if (totalDeviceActions === 0) {
    alert('No recorded actions found! Please record some interactions first.');
    return;
  }
  
  console.log(`Using device-specific actions:`, deviceSpecificActions);
  
  if (webviews.length === 0) {
    alert("No webviews to screenshot!");
    return;
  }

  const button = document.querySelector('button[onclick="screenshotAllWithReplay()"]');
  const originalHTML = button.innerHTML;
  button.innerHTML = '<svg class="icon"><use href="#icon-video"></use></svg>Replaying & Screenshot...';
  button.disabled = true;
  
  // Set flag to prevent resize handler from reloading presets
  isScreenshotting = true;

  try {
    const { ipcRenderer } = require("electron");
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

    // Create screenshots directory if it doesn't exist
    const screenshotsDir = require("path").join(process.cwd(), "screenshots");
    const fs = require("fs");
    
    console.log("Screenshots directory:", screenshotsDir);

    if (!fs.existsSync(screenshotsDir)) {
      console.log("Creating screenshots directory...");
      fs.mkdirSync(screenshotsDir);
    }

    let successCount = 0;
    const totalCount = webviews.length;

    // Take screenshot of each webview with replay
    for (let i = 0; i < webviews.length; i++) {
      const webview = webviews[i];
      const deviceName = webview.deviceName ? webview.deviceName.replace(/[^a-zA-Z0-9]/g, "_") : `device_${i}`;
      
      // Get device-specific actions for this device
      const deviceActions = deviceSpecificActions[webview.deviceName] || [];
      console.log(`Processing webview ${i + 1}/${totalCount}: ${deviceName} with ${deviceActions.length} device-specific actions`);

      try {
        // Get device info
        const deviceScaleFactor = webview.deviceInfo?.deviceScaleFactor || 1;
        const logicalWidth = webview.deviceInfo?.width || 375;
        const logicalHeight = webview.deviceInfo?.height || 667;
        const physicalWidth = logicalWidth * deviceScaleFactor;
        const physicalHeight = logicalHeight * deviceScaleFactor;
        
        const currentURL = webview.getURL();
        console.log(`  URL: ${currentURL}`);
        console.log(`  Device scale factor: ${deviceScaleFactor}`);
        console.log(`  Dimensions: ${logicalWidth}x${logicalHeight} (logical), ${physicalWidth}x${physicalHeight} (physical)`);

        // Extract app state
        console.log(`  Extracting app state from webview...`);
        let appState = null;
        
        try {
          appState = await webview.executeJavaScript(`
            (async function() {
              const state = {
                localStorage: {},
                sessionStorage: {},
                indexedDB: {}
              };
              
              // Extract localStorage
              for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                state.localStorage[key] = localStorage.getItem(key);
              }
              
              // Extract sessionStorage
              for (let i = 0; i < sessionStorage.length; i++) {
                const key = sessionStorage.key(i);
                state.sessionStorage[key] = sessionStorage.getItem(key);
              }
              
              return state;
            })()
          `);
          
          console.log(`  Extracted state:`, Object.keys(appState.localStorage).length, 'localStorage items,', 
                     Object.keys(appState.sessionStorage).length, 'sessionStorage items');
        } catch (stateError) {
          console.warn(`  Failed to extract app state:`, stateError);
          appState = null;
        }
        
        // Use Playwright with device-specific actions
        const buffer = await ipcRenderer.invoke('capture-playwright-screenshot', {
          url: currentURL,
          width: logicalWidth,
          height: logicalHeight, 
          deviceScaleFactor: deviceScaleFactor,
          userAgent: webview.getAttribute('useragent'),
          appState: appState,
          recordedActions: deviceActions // Use device-specific actions instead of generic ones
        });
        
        console.log(`  ✅ Screenshot with replay successful (${buffer.length} bytes)`);

        const dpiSuffix = deviceScaleFactor > 1 ? `_${deviceScaleFactor}x` : "";
        const filename = `screenshot_replay_${timestamp}_${deviceName}${dpiSuffix}.png`;
        const filepath = require("path").join(screenshotsDir, filename);

        console.log(`  Writing to file: ${filepath}`);
        fs.writeFileSync(filepath, buffer);
        successCount++;

        console.log(`  ✅ Screenshot saved: ${filepath}`);
        console.log(
          `    Logical: ${logicalWidth}x${logicalHeight} (website sees this)`
        );
        console.log(
          `    Physical: ${physicalWidth}x${physicalHeight} (screenshot target)`
        );
        console.log(`    Scale: ${deviceScaleFactor}x`);
        console.log(`    Actions replayed: ${deviceActions.length} (device-specific for ${webview.deviceName})`);
      } catch (error) {
        console.error(`Failed to screenshot ${deviceName}:`, error);
        console.error(`  Error details:`, error.stack);
      }
    }

    console.log(`Screenshot with replay process complete: ${successCount}/${totalCount} successful`);
    alert(
      `Screenshots with replay complete! Saved ${successCount}/${totalCount} screenshots to /screenshots folder`
    );
    // Reset UI to default
    setUIMode('default');
    // Clear recorded actions
    deviceSpecificActions = {};
  } catch (error) {
    console.error("Screenshot with replay error:", error);
    console.error("Error stack:", error.stack);
    alert(`Failed to take screenshots with replay: ${error.message}\n\nCheck DevTools console for details.`);
  } finally {
    // Reset flag
    isScreenshotting = false;
    button.innerHTML = originalHTML;
    button.disabled = false;
  }
};

// Manual screenshot mode
let manualModeActive = false;
let manualModeBrowsers = [];

window.openManualMode = async function() {
  console.log('Opening manual screenshot mode...');
  
  if (manualModeActive) {
    alert('Manual mode is already active!');
    return;
  }
  
  const manualBtn = document.getElementById('manualModeBtn');
  
  manualBtn.textContent = '⏳ Extracting state...';
  manualBtn.disabled = true;
  
  try {
    const { ipcRenderer } = require('electron');
    
    // Extract state from the first webview (they should have similar state due to sync)
    let appState = null;
    if (webviews.length > 0) {
      console.log('Extracting app state from preview webviews...');
      
      try {
        appState = await webviews[0].executeJavaScript(`
          (async function() {
            const state = {
              localStorage: {},
              sessionStorage: {},
              indexedDB: {}
            };
            
            // Extract localStorage
            for (let i = 0; i < localStorage.length; i++) {
              const key = localStorage.key(i);
              state.localStorage[key] = localStorage.getItem(key);
            }
            
            // Extract sessionStorage
            for (let i = 0; i < sessionStorage.length; i++) {
              const key = sessionStorage.key(i);
              state.sessionStorage[key] = sessionStorage.getItem(key);
            }
            
            // Extract indexedDB (basic approach)
            try {
              const databases = await indexedDB.databases();
              for (const dbInfo of databases) {
                if (dbInfo.name) {
                  state.indexedDB[dbInfo.name] = {
                    name: dbInfo.name,
                    version: dbInfo.version
                  };
                }
              }
            } catch (e) {
              console.log('IndexedDB extraction skipped:', e.message);
            }
            
            return state;
          })()
        `);
        
        console.log('Extracted state:', Object.keys(appState.localStorage).length, 'localStorage items,', 
                   Object.keys(appState.sessionStorage).length, 'sessionStorage items,',
                   Object.keys(appState.indexedDB).length, 'indexedDB databases');
      } catch (stateError) {
        console.warn('Failed to extract app state:', stateError);
        appState = null;
      }
    }
    
    manualBtn.textContent = '⏳ Opening browsers...';
    
    // Get current device configuration from active webviews
    const currentDevices = [];
    webviews.forEach((webview, index) => {
      if (webview.deviceInfo && webview.deviceName) {
        currentDevices.push({
          name: webview.deviceName,
          width: webview.deviceInfo.width,
          height: webview.deviceInfo.height,
          deviceScaleFactor: webview.deviceInfo.deviceScaleFactor || 1
        });
      }
    });
    
    if (currentDevices.length === 0) {
      throw new Error('No devices found in preview. Please load a device preset first.');
    }
    
    console.log('Using current preview devices:', currentDevices.map(d => `${d.name} (${d.width}x${d.height} @ ${d.deviceScaleFactor}x)`));
    
    // Open browsers for each device size for manual navigation
    const result = await ipcRenderer.invoke('open-manual-browsers', {
      url: currentURL || 'http://localhost:8080/',
      appState: appState,
      devices: currentDevices
    });
    
    if (result.success) {
      manualModeActive = true;
      manualModeBrowsers = result.browsers;
      
      // Switch to manual mode UI
      setUIMode('manual');
      
      // Generate device list for user message
      const deviceList = currentDevices.map(d => 
        `• ${d.name} (${d.width}x${d.height} @ ${d.deviceScaleFactor}x)`
      ).join('\n');
      
      alert(`Manual mode active! 
      
${currentDevices.length} browser windows are now open:
${deviceList}

Navigate to the exact state you want in each browser, then click \"Take Screenshots Now\"`);
      
    } else {
      throw new Error(result.error || 'Failed to open browsers');
    }
    
  } catch (error) {
    console.error('Failed to open manual mode:', error);
    alert(`Failed to open manual mode: ${error.message}`);
    
    manualBtn.innerHTML = '<svg class="icon"><use href="#icon-launch"></use></svg>Manual Mode';
    manualBtn.disabled = false;
  }
};

window.triggerRemoteScreenshot = async function() {
  if (!manualModeActive) {
    alert('Manual mode is not active!');
    return;
  }
  
  console.log('Triggering remote screenshots...');
  
  const triggerBtn = document.getElementById('triggerScreenshotBtn');
  const originalHTML = triggerBtn.innerHTML;
  triggerBtn.innerHTML = '<svg class="icon"><use href="#icon-camera"></use></svg>Taking Screenshots...';
  triggerBtn.disabled = true;
  
  try {
    const { ipcRenderer } = require('electron');
    
    const result = await ipcRenderer.invoke('capture-manual-screenshots', {
      browsers: manualModeBrowsers
    });
    
    if (result.success) {
      // Reset UI since browsers are auto-closed
      manualModeActive = false;
      manualModeBrowsers = [];
      
      // Reset UI to default
      setUIMode('default');
      
      const autoCloseMsg = result.autoClosedBrowsers ? '\n\n✅ All browser windows closed automatically.' : '';
      
      alert(`Screenshots complete! 
      
Saved ${result.count} screenshots to /screenshots folder:
${result.filenames.join('\n')}${autoCloseMsg}`);
    } else {
      throw new Error(result.error || 'Failed to capture screenshots');
    }
    
  } catch (error) {
    console.error('Failed to capture manual screenshots:', error);
    alert(`Failed to capture screenshots: ${error.message}`);
  } finally {
    triggerBtn.innerHTML = originalHTML;
    triggerBtn.disabled = false;
  }
};

window.closeManualMode = async function() {
  if (!manualModeActive) return;
  
  console.log('Closing manual mode and all browsers...');
  
  try {
    const { ipcRenderer } = require('electron');
    const result = await ipcRenderer.invoke('close-manual-browsers');
    
    if (!result.success) {
      console.error('Failed to close browsers:', result.error);
      alert('Warning: Some browsers may not have closed properly. You may need to close them manually.');
    }
    
    manualModeActive = false;
    manualModeBrowsers = [];
    
    console.log('Manual mode closed');
  } catch (error) {
    console.error('Failed to close manual mode:', error);
    alert('Error closing browsers. You may need to close them manually or restart the app.');
  }
};

// Cancel mode function
window.cancelMode = async function() {
  console.log('Cancelling current mode...');
  
  // Stop recording if active
  if (isRecording) {
    isRecording = false;
    webviews.forEach((webview, index) => {
      try {
        webview.executeJavaScript('window.stopRecording && window.stopRecording();');
      } catch (e) {
        console.warn(`Failed to stop recording in webview ${index}:`, e);
      }
    });
  }
  
  // Close manual mode if active
  if (manualModeActive) {
    await closeManualMode();
  }
  
  // Clear any recorded actions
  recordedActions = [];
  deviceSpecificActions = {};
  
  // Reset UI to default
  setUIMode('default');
  
  console.log('Mode cancelled and reset to default');
};

// Advanced Capture dropdown toggle
window.toggleAdvancedCapture = function() {
  const toggle = document.querySelector('.advanced-capture-toggle');
  const menu = document.getElementById('advancedCaptureMenu');
  
  toggle.classList.toggle('open');
  menu.classList.toggle('open');
};

// Auto-close manual mode when app closes
window.addEventListener('beforeunload', closeManualMode);

// Sidebar and dropdown functions
function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebarOverlay');
  
  sidebar.classList.toggle('open');
  overlay.classList.toggle('active');
}

function togglePresetDropdown() {
  const toggle = document.querySelector('.preset-dropdown-toggle');
  const menu = document.getElementById('presetDropdownMenu');
  
  toggle.classList.toggle('open');
  menu.classList.toggle('open');
}

function selectPreset(presetName) {
  currentPreset = presetName;
  document.getElementById('currentPresetName').textContent = getPresetDisplayName(presetName);
  
  // Update active item in dropdown
  document.querySelectorAll('.preset-dropdown-item').forEach(item => {
    item.classList.remove('active');
  });
  document.querySelector(`[onclick="selectPreset('${presetName}')"]`).classList.add('active');
  
  // Close dropdown
  togglePresetDropdown();
  
  // Show/hide custom preset controls
  const customControls = document.getElementById('customPresetControls');
  if (presetName === 'custom') {
    customControls.classList.remove('hidden');
    toggleSidebar(); // Open sidebar for custom preset selection
  } else {
    customControls.classList.add('hidden');
    loadPresetInternal(presetName);
  }
}

function getPresetDisplayName(presetName) {
  const names = {
    'responsive': 'Responsive',
    'mobile': 'Mobile', 
    'tablet': 'Tablet',
    'desktop': 'Desktop',
    'app-store': 'App Store',
    'app-store-hd': 'App Store HD',
    'play-store': 'Play Store', 
    'play-store-hd': 'Play Store HD',
    'custom': 'Custom'
  };
  return names[presetName] || presetName;
}

function populateDeviceList() {
  const deviceList = document.getElementById('deviceList');
  deviceList.innerHTML = '';
  
  // Group devices by category
  const categories = {
    'Mobile Phones': [],
    'Tablets': [],
    'Desktops': [],
    'App Store Sizes': []
  };
  
  Object.keys(devices).forEach(deviceName => {
    const device = devices[deviceName];
    let category = 'Mobile Phones';
    
    if (deviceName.includes('iPad') || deviceName.includes('Tab')) {
      category = 'Tablets';
    } else if (deviceName.includes('MacBook') || deviceName.includes('Desktop') || deviceName.includes('Mac App Store')) {
      category = 'Desktops';
    } else if (deviceName.includes('App Store') || deviceName.includes('Play Store')) {
      category = 'App Store Sizes';
    }
    
    categories[category].push({ name: deviceName, ...device });
  });
  
  // Create HTML for each category
  Object.keys(categories).forEach(categoryName => {
    if (categories[categoryName].length === 0) return;
    
    const categoryDiv = document.createElement('div');
    categoryDiv.className = 'device-category';
    
    const titleDiv = document.createElement('div');
    titleDiv.className = 'category-title';
    titleDiv.textContent = categoryName;
    categoryDiv.appendChild(titleDiv);
    
    categories[categoryName].forEach(device => {
      const deviceItem = document.createElement('div');
      deviceItem.className = 'device-item';
      deviceItem.onclick = () => toggleDeviceSelection(device.name);
      
      const deviceInfo = document.createElement('div');
      deviceInfo.className = 'device-info';
      
      const deviceNameDiv = document.createElement('div');
      deviceNameDiv.className = 'device-item-name';
      deviceNameDiv.textContent = device.name;
      deviceInfo.appendChild(deviceNameDiv);
      
      const deviceSizeDiv = document.createElement('div');
      deviceSizeDiv.className = 'device-item-size';
      deviceSizeDiv.textContent = `${device.width} × ${device.height}`;
      if (device.deviceScaleFactor && device.deviceScaleFactor !== 1) {
        deviceSizeDiv.textContent += ` @ ${device.deviceScaleFactor}x`;
      }
      deviceInfo.appendChild(deviceSizeDiv);
      
      const selectedIcon = document.createElement('div');
      selectedIcon.className = 'device-selected-icon';
      selectedIcon.textContent = '✓';
      
      deviceItem.appendChild(deviceInfo);
      deviceItem.appendChild(selectedIcon);
      categoryDiv.appendChild(deviceItem);
    });
    
    deviceList.appendChild(categoryDiv);
  });
}

function toggleDeviceSelection(deviceName) {
  const index = customDeviceSelection.indexOf(deviceName);
  
  // Find the device item by looking for the one containing this device name
  const deviceItems = document.querySelectorAll('.device-item');
  let deviceItem = null;
  
  deviceItems.forEach(item => {
    const nameElement = item.querySelector('.device-item-name');
    if (nameElement && nameElement.textContent === deviceName) {
      deviceItem = item;
    }
  });
  
  if (index === -1) {
    customDeviceSelection.push(deviceName);
    if (deviceItem) deviceItem.classList.add('selected');
  } else {
    customDeviceSelection.splice(index, 1);
    if (deviceItem) deviceItem.classList.remove('selected');
  }
  
  updateSelectedDevicesList();
}

function updateSelectedDevicesList() {
  const list = document.getElementById('selectedDeviceList');
  list.innerHTML = '';
  
  customDeviceSelection.forEach(deviceName => {
    const tag = document.createElement('div');
    tag.className = 'selected-device-tag';
    
    const nameSpan = document.createElement('span');
    nameSpan.textContent = deviceName;
    
    const removeBtn = document.createElement('button');
    removeBtn.className = 'selected-device-remove';
    removeBtn.textContent = '×';
    removeBtn.onclick = (e) => {
      e.stopPropagation();
      toggleDeviceSelection(deviceName);
    };
    
    tag.appendChild(nameSpan);
    tag.appendChild(removeBtn);
    list.appendChild(tag);
  });
}

function applyCustomPreset() {
  if (customDeviceSelection.length === 0) {
    alert('Please select at least one device for your custom preset.');
    return;
  }
  
  // Add custom preset to presets object
  presets.custom = [...customDeviceSelection];
  
  // Load the custom preset
  loadPresetInternal('custom');
  
  // Close sidebar
  toggleSidebar();
}

// Close dropdowns when clicking outside
document.addEventListener('click', (e) => {
  // Close preset dropdown
  if (!e.target.closest('.preset-dropdown')) {
    const toggle = document.querySelector('.preset-dropdown-toggle');
    const menu = document.getElementById('presetDropdownMenu');
    if (toggle) toggle.classList.remove('open');
    if (menu) menu.classList.remove('open');
  }
  
  // Close advanced capture dropdown
  if (!e.target.closest('.advanced-capture-dropdown')) {
    const advancedToggle = document.querySelector('.advanced-capture-toggle');
    const advancedMenu = document.getElementById('advancedCaptureMenu');
    if (advancedToggle) advancedToggle.classList.remove('open');
    if (advancedMenu) advancedMenu.classList.remove('open');
  }
});

// Global function exports
window.toggleHistory = toggleHistory;
window.screenshotAll = screenshotAll;
window.toggleSidebar = toggleSidebar;
window.togglePresetDropdown = togglePresetDropdown;
window.selectPreset = selectPreset;
window.applyCustomPreset = applyCustomPreset;
window.toggleAdvancedCapture = toggleAdvancedCapture;
window.cancelMode = cancelMode;

// Debug helper
window.showDebugInfo = function () {
  console.log("Webviews:", webviews.length);
  console.log("Sync Settings:", syncSettings);
  webviews.forEach((wv, i) => {
    console.log(`Webview ${i}:`, wv.getURL(), wv.deviceName);
  });
};
