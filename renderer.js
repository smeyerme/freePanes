// renderer.js - Simplified reliable version
const { ipcRenderer } = require("electron");

const devices = {
  "iPhone 14 Pro": { width: 393, height: 852 },
  "iPhone SE": { width: 375, height: 667 },
  "iPad Air": { width: 820, height: 1180 },
  "iPad Pro": { width: 1024, height: 1366 },
  "MacBook Air": { width: 1280, height: 800 },
  "Desktop HD": { width: 1920, height: 1080 },
};

const presets = {
  responsive: ["iPhone 14 Pro", "iPad Air", "MacBook Air"],
  mobile: ["iPhone 14 Pro", "iPhone SE", "iPad Air"],
  desktop: ["MacBook Air", "Desktop HD"],
};

let webviews = [];
let currentURL = "https://github.com";
let syncSettings = {
  scroll: true,
  navigation: true, // Sync URL/route changes
  click: true, // Sync clicks (smart mode)
  hover: false, // Disabled by default for performance
  input: false, // Disabled by default for SPA compatibility
};

function createViewport(deviceName) {
  const device = devices[deviceName];
  const scale = calculateScale(device);

  const viewportDiv = document.createElement("div");
  viewportDiv.className = "viewport";

  // Create header
  const header = document.createElement("div");
  header.className = "viewport-header";
  header.innerHTML = `
    <span class="device-name">${deviceName}</span>
    <span class="device-size">${device.width} × ${device.height}</span>
  `;
  viewportDiv.appendChild(header);

  // Create webview container
  const container = document.createElement("div");
  container.className = "webview-container";
  container.style.width = device.width * scale + "px";
  container.style.height = device.height * scale + "px";
  container.style.position = "relative";
  container.style.overflow = "hidden";

  // Create webview
  const webview = document.createElement("webview");
  webview.src = currentURL;
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

  // Allow mixed content and disable some security for local dev
  webview.setAttribute("allowpopups", "true");
  webview.setAttribute("webpreferences", "allowRunningInsecureContent=true");

  container.appendChild(webview);
  viewportDiv.appendChild(container);

  // Store device info
  webview.deviceInfo = device;
  webview.deviceName = deviceName;

  // Wait for DOM ready before injecting scripts
  webview.addEventListener("dom-ready", () => {
    // Only inject if sync is needed
    if (syncSettings.scroll || syncSettings.hover || syncSettings.input) {
      setupWebviewSync(webview);
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
  // Simplified sync script - only essentials
  const syncScript = `
    (function() {
      let isProcessingSync = false;
      let lastScrollTime = 0;
      let lastClickTime = 0;
      
      // Only sync scroll - the most reliable sync
      if (${syncSettings.scroll}) {
        window.addEventListener('scroll', function() {
          if (isProcessingSync) return;
          
          const now = Date.now();
          if (now - lastScrollTime < 50) return; // Throttle
          lastScrollTime = now;
          
          const data = {
            percentX: window.scrollX / Math.max(1, document.documentElement.scrollWidth - window.innerWidth),
            percentY: window.scrollY / Math.max(1, document.documentElement.scrollHeight - window.innerHeight)
          };
          
          console.log('SYNC:SCROLL:' + JSON.stringify(data));
        }, { passive: true });
      }
      
      // Smart click sync
      if (${syncSettings.click}) {
        document.addEventListener('click', function(e) {
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
          
        }, true); // Use capture phase
      }
      
      // Simple hover tracking if enabled
      if (${syncSettings.hover}) {
        let hoverTimer = null;
        document.addEventListener('mousemove', function(e) {
          if (isProcessingSync) return;
          
          clearTimeout(hoverTimer);
          hoverTimer = setTimeout(() => {
            const el = document.elementFromPoint(e.clientX, e.clientY);
            if (el && el.id) {
              console.log('SYNC:HOVER:' + JSON.stringify({ id: el.id }));
            }
          }, 100);
        }, { passive: true });
      }
      
      // Minimal input sync if enabled
      if (${syncSettings.input}) {
        let inputTimer = null;
        document.addEventListener('input', function(e) {
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
        }, true);
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
            } else if (type === 'hover' && data.id) {
              const el = document.getElementById(data.id);
              if (el) {
                el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
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

  // Listen for sync messages
  webview.addEventListener("console-message", (e) => {
    if (!e.message.startsWith("SYNC:")) return;

    try {
      if (e.message.startsWith("SYNC:SCROLL:") && syncSettings.scroll) {
        const data = JSON.parse(e.message.replace("SYNC:SCROLL:", ""));
        syncToOtherWebviews(webview, "scroll", data);
      } else if (e.message.startsWith("SYNC:CLICK:") && syncSettings.click) {
        const data = JSON.parse(e.message.replace("SYNC:CLICK:", ""));
        syncToOtherWebviews(webview, "click", data);
      } else if (e.message.startsWith("SYNC:HOVER:") && syncSettings.hover) {
        const data = JSON.parse(e.message.replace("SYNC:HOVER:", ""));
        syncToOtherWebviews(webview, "hover", data);
      } else if (e.message.startsWith("SYNC:INPUT:") && syncSettings.input) {
        const data = JSON.parse(e.message.replace("SYNC:INPUT:", ""));
        syncToOtherWebviews(webview, "input", data);
      }
    } catch (err) {
      // Ignore parse errors
    }
  });
}

function syncToOtherWebviews(sourceWebview, type, data) {
  webviews.forEach((webview) => {
    if (webview !== sourceWebview && webview.getURL()) {
      const script = `
        if (typeof window.applySyncAction === 'function') {
          window.applySyncAction('${type}', ${JSON.stringify(data)});
        }
      `;

      webview.executeJavaScript(script, false).catch(() => {
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

// Setup sync toggles
function setupSyncToggles() {
  // Scroll sync
  const scrollToggle = document.getElementById("syncScroll");
  if (scrollToggle) {
    scrollToggle.addEventListener("click", function (e) {
      if (e.target.tagName === "INPUT") return;
      const checkbox = this.querySelector("input");
      checkbox.checked = !checkbox.checked;
      this.classList.toggle("active", checkbox.checked);
      syncSettings.scroll = checkbox.checked;
      reinjectSyncScripts();
    });
  }

  // Navigation sync
  const navToggle = document.getElementById("syncNavigation");
  if (navToggle) {
    navToggle.addEventListener("click", function (e) {
      if (e.target.tagName === "INPUT") return;
      const checkbox = this.querySelector("input");
      checkbox.checked = !checkbox.checked;
      this.classList.toggle("active", checkbox.checked);
      syncSettings.navigation = checkbox.checked;
    });
  }

  // Click sync
  const clickToggle = document.getElementById("syncClick");
  if (clickToggle) {
    clickToggle.addEventListener("click", function (e) {
      if (e.target.tagName === "INPUT") return;
      const checkbox = this.querySelector("input");
      checkbox.checked = !checkbox.checked;
      this.classList.toggle("active", checkbox.checked);
      syncSettings.click = checkbox.checked;
      reinjectSyncScripts();
    });
  }

  // Hover sync (disabled by default)
  const hoverToggle = document.getElementById("syncHover");
  if (hoverToggle) {
    hoverToggle.addEventListener("click", function (e) {
      if (e.target.tagName === "INPUT") return;
      const checkbox = this.querySelector("input");
      checkbox.checked = !checkbox.checked;
      this.classList.toggle("active", checkbox.checked);
      syncSettings.hover = checkbox.checked;
      reinjectSyncScripts();
    });
  }

  // Input sync (disabled by default)
  const inputToggle = document.getElementById("syncInput");
  if (inputToggle) {
    inputToggle.addEventListener("click", function (e) {
      if (e.target.tagName === "INPUT") return;
      const checkbox = this.querySelector("input");
      checkbox.checked = !checkbox.checked;
      this.classList.toggle("active", checkbox.checked);
      syncSettings.input = checkbox.checked;
      reinjectSyncScripts();
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

  // Load default preset
  loadPresetInternal("responsive");
});

// Debug helper
window.showDebugInfo = function () {
  console.log("Webviews:", webviews.length);
  console.log("Sync Settings:", syncSettings);
  webviews.forEach((wv, i) => {
    console.log(`Webview ${i}:`, wv.getURL(), wv.deviceName);
  });
};
