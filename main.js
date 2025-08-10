// main.js - Electron Main Process
const { app, BrowserWindow, ipcMain, session } = require("electron");
const path = require("path");
const fs = require("fs");

let mainWindow;

app.whenReady().then(() => {
  createMainWindow();
  setupIPCHandlers();
});

// Clean up browsers when app is quitting
app.on('before-quit', async (event) => {
  console.log('App is quitting, cleaning up browsers...');
  
  // Close any manual browsers
  if (manualBrowsers.length > 0) {
    event.preventDefault();
    
    for (const { browser } of manualBrowsers) {
      if (browser) {
        try {
          await browser.close();
        } catch (error) {
          console.error('Error closing browser on quit:', error);
          // Force kill if needed
          if (browser._process) {
            try {
              browser._process.kill('SIGKILL');
            } catch (killError) {
              console.error('Error force-killing browser on quit:', killError);
            }
          }
        }
      }
    }
    
    manualBrowsers = [];
    app.quit();
  }
});

// Handle window closed
app.on('window-all-closed', async () => {
  // Close any remaining browsers
  for (const { browser } of manualBrowsers) {
    if (browser) {
      try {
        await browser.close();
      } catch (error) {
        console.error('Error closing browser on window close:', error);
      }
    }
  }
  
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 1000,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webviewTag: true,
    },
    backgroundColor: "#1a1a1a",
  });

  mainWindow.loadFile("index.html");

  // Open DevTools for debugging
  // mainWindow.webContents.openDevTools();
}

function setupIPCHandlers() {
  // Handle temporary window resize for full-page capture
  ipcMain.handle('resize-window-temporarily', async (event, { width, height }) => {
    console.log(`IPC: Temporarily resizing window to ${width}x${height}`);
    
    // Store original bounds
    const originalBounds = mainWindow.getBounds();
    
    try {
      // Resize window
      mainWindow.setBounds({
        x: originalBounds.x,
        y: originalBounds.y,
        width: Math.ceil(width),
        height: Math.ceil(height) + 200 // Extra height for chrome
      }, false);
      
      // Wait for resize to complete
      await new Promise(resolve => setTimeout(resolve, 100));
      
      return { success: true, originalBounds };
    } catch (error) {
      console.error('IPC: Error resizing window:', error);
      return { success: false, error: error.message, originalBounds };
    }
  });
  
  // Handle window restoration
  ipcMain.handle('restore-window-size', async (event, { originalBounds }) => {
    console.log('IPC: Restoring window to original size');
    
    try {
      mainWindow.setBounds(originalBounds, true);
      await new Promise(resolve => setTimeout(resolve, 100));
      return { success: true };
    } catch (error) {
      console.error('IPC: Error restoring window:', error);
      return { success: false, error: error.message };
    }
  });
  
  // Handle image stitching
  ipcMain.handle('stitch-images', async (event, { chunks, finalWidth, finalHeight, deviceScaleFactor }) => {
    console.log(`IPC: Stitching ${chunks.length} chunks into ${finalWidth}x${finalHeight} image @ ${deviceScaleFactor}x`);
    
    const { nativeImage } = require('electron');
    const { createCanvas, Image } = require('canvas');
    
    try {
      // Calculate final dimensions with device scale factor
      const canvasWidth = Math.ceil(finalWidth * deviceScaleFactor);
      const canvasHeight = Math.ceil(finalHeight * deviceScaleFactor);
      
      console.log(`IPC: Creating canvas ${canvasWidth}x${canvasHeight}`);
      
      // Create canvas for stitching
      const canvas = createCanvas(canvasWidth, canvasHeight);
      const ctx = canvas.getContext('2d');
      
      // Set white background
      ctx.fillStyle = 'white';
      ctx.fillRect(0, 0, canvasWidth, canvasHeight);
      
      // Draw each chunk at its position
      for (const chunk of chunks) {
        const img = new Image();
        img.src = Buffer.from(chunk.buffer);
        
        // Calculate position with device scale factor
        const x = Math.round(chunk.x * deviceScaleFactor);
        const y = Math.round(chunk.y * deviceScaleFactor);
        
        console.log(`IPC: Drawing chunk at ${x},${y}`);
        ctx.drawImage(img, x, y);
      }
      
      // Convert canvas to PNG buffer
      const buffer = canvas.toBuffer('image/png');
      console.log(`IPC: Stitching complete, buffer size: ${buffer.length}`);
      
      return buffer;
      
    } catch (error) {
      console.error('IPC: Error stitching images:', error);
      
      // Fallback: return the first chunk
      if (chunks.length > 0) {
        console.log('IPC: Falling back to first chunk');
        return chunks[0].buffer;
      }
      
      throw error;
    }
  });
  
  // Handle Playwright-based screenshot (better than Puppeteer for this use case)
  ipcMain.handle('capture-playwright-screenshot', async (event, options) => {
    console.log('IPC: capture-playwright-screenshot called');
    const { url, width, height, deviceScaleFactor, userAgent, appState, recordedActions } = options;
    
    const { chromium } = require('playwright');
    let browser = null;
    
    try {
      console.log(`IPC: Launching Playwright for ${width}x${height} @ ${deviceScaleFactor}x`);
      
      // Launch browser (visible for debugging)
      browser = await chromium.launch({
        headless: false, // Make browser visible!
        slowMo: 500, // Slow down actions so you can see them
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-web-security',
          '--allow-running-insecure-content'
        ]
      });
      
      const context = await browser.newContext({
        viewport: {
          width: width,
          height: height
        },
        deviceScaleFactor: deviceScaleFactor,
        userAgent: userAgent
      });
      
      const page = await context.newPage();
      
      // Inject app state if provided
      if (appState) {
        console.log('IPC: Injecting app state into browser context...');
        
        await page.addInitScript((injectedState) => {
          // Restore localStorage
          if (injectedState.localStorage) {
            for (const [key, value] of Object.entries(injectedState.localStorage)) {
              try {
                localStorage.setItem(key, value);
              } catch (e) {
                console.warn('Failed to set localStorage item:', key, e);
              }
            }
          }
          
          // Restore sessionStorage
          if (injectedState.sessionStorage) {
            for (const [key, value] of Object.entries(injectedState.sessionStorage)) {
              try {
                sessionStorage.setItem(key, value);
              } catch (e) {
                console.warn('Failed to set sessionStorage item:', key, e);
              }
            }
          }
          
          // Note: IndexedDB restoration would be more complex
          // For now, we just inject the basic storage
          console.log('App state injected:', 
            Object.keys(injectedState.localStorage || {}).length, 'localStorage items,',
            Object.keys(injectedState.sessionStorage || {}).length, 'sessionStorage items');
        }, appState);
      }
      
      console.log(`IPC: Loading ${url}`);
      
      // Navigate to URL
      await page.goto(url, {
        waitUntil: 'networkidle',
        timeout: 10000
      });
      
      // Wait for content to fully load and app to initialize with injected state
      await page.waitForTimeout(3000);
      
      // Wait specifically for Vue.js to be ready
      console.log('IPC: Waiting for Vue.js to initialize...');
      await page.waitForFunction(() => {
        // Check if Vue is available and components are mounted
        return window.Vue || 
               document.querySelector('[data-v-]') || 
               document.querySelector('.app-container') ||
               document.readyState === 'complete';
      }, { timeout: 5000 });
      
      // Additional wait for Vue component mounting and event listeners
      await page.waitForTimeout(2000);
      console.log('IPC: Vue initialization complete');
      
      // Replay recorded actions if provided
      if (recordedActions && recordedActions.length > 0) {
        console.log(`IPC: Replaying ${recordedActions.length} recorded actions...`);
        
        for (let i = 0; i < recordedActions.length; i++) {
          const action = recordedActions[i];
          try {
            console.log(`IPC: Replaying ${i + 1}/${recordedActions.length} - ${action.type}:`, action);
            
            if (action.type === 'click') {
              // Debug: Check if element exists
              if (action.selector) {
                const elementExists = await page.evaluate((selector) => {
                  const element = document.querySelector(selector);
                  if (element) {
                    const rect = element.getBoundingClientRect();
                    return {
                      exists: true,
                      visible: rect.width > 0 && rect.height > 0,
                      rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
                      text: element.textContent?.substring(0, 50) || '',
                      tagName: element.tagName
                    };
                  }
                  return { exists: false };
                }, action.selector);
                
                console.log(`IPC: Element debug for ${action.selector}:`, elementExists);
                
                if (elementExists.exists && elementExists.visible) {
                  // Check if we clicked the right element by comparing text
                  if (action.text && elementExists.text.trim() !== action.text.trim()) {
                    console.log(`IPC: ⚠️ Wrong element found! Expected: "${action.text}", Got: "${elementExists.text}"`);
                    
                    // Try to find by text content, but only visible elements
                    console.log(`IPC: Trying to find VISIBLE element by text instead...`);
                    
                    try {
                      const textToFind = action.text.trim();
                      // Use a more specific search that only finds visible elements
                      const visibleElement = await page.evaluate((text) => {
                        // Find all elements containing the text
                        const walker = document.createTreeWalker(
                          document.body,
                          NodeFilter.SHOW_TEXT,
                          null,
                          false
                        );
                        
                        const candidates = [];
                        let textNode;
                        while (textNode = walker.nextNode()) {
                          if (textNode.textContent.includes(text)) {
                            const element = textNode.parentElement;
                            const rect = element.getBoundingClientRect();
                            // Only consider visible elements
                            if (rect.width > 0 && rect.height > 0) {
                              candidates.push({
                                element: element,
                                rect: rect,
                                text: element.textContent,
                                selector: element.tagName.toLowerCase()
                              });
                            }
                          }
                        }
                        
                        // Return info about the first visible candidate
                        if (candidates.length > 0) {
                          const best = candidates[0];
                          return {
                            found: true,
                            x: best.rect.left + best.rect.width / 2,
                            y: best.rect.top + best.rect.height / 2,
                            text: best.text,
                            rect: best.rect
                          };
                        }
                        
                        return { found: false };
                      }, textToFind);
                      
                      if (visibleElement.found) {
                        // Try different click methods for better compatibility
                        console.log(`IPC: Attempting click on visible element by text: "${textToFind}" at (${visibleElement.x}, ${visibleElement.y})`);
                        
                        // Try Vue-friendly click sequence
                        try {
                          // First, ensure element is focused and ready
                          await page.evaluate((coords) => {
                            const element = document.elementFromPoint(coords.x, coords.y);
                            if (element) {
                              // Focus the element first
                              element.focus();
                              // Small delay for focus
                              return new Promise(resolve => setTimeout(resolve, 100));
                            }
                          }, { x: visibleElement.x, y: visibleElement.y });
                          
                          // Method 1: Try Playwright's click (most reliable for Vue)
                          try {
                            // Find element again and use Playwright's click
                            await page.evaluate((coords, text) => {
                              const element = document.elementFromPoint(coords.x, coords.y);
                              if (element && element.textContent.includes(text)) {
                                // Mark element for Playwright to find
                                element.setAttribute('data-playwright-click-target', 'true');
                              }
                            }, { x: visibleElement.x, y: visibleElement.y }, textToFind);
                            
                            // Use Playwright's click on the marked element
                            await page.click('[data-playwright-click-target="true"]', { timeout: 1000 });
                            console.log(`IPC: ✅ Playwright click on Vue element completed`);
                            
                            // Clean up the marker
                            await page.evaluate(() => {
                              const el = document.querySelector('[data-playwright-click-target="true"]');
                              if (el) el.removeAttribute('data-playwright-click-target');
                            });
                            
                          } catch (playwrightError) {
                            console.log(`IPC: Playwright click failed: ${playwrightError.message}`);
                            
                            // Method 2: Mouse click with Vue event simulation
                            await page.mouse.click(visibleElement.x, visibleElement.y);
                            console.log(`IPC: ✅ Mouse click completed`);
                            
                            // Method 3: Comprehensive Vue event dispatching
                            await page.evaluate((coords) => {
                              const element = document.elementFromPoint(coords.x, coords.y);
                              if (element) {
                                console.log('Dispatching Vue-friendly events on:', element);
                                
                                // Simulate complete click sequence for Vue
                                const events = ['mousedown', 'mouseup', 'click'];
                                events.forEach(eventType => {
                                  const event = new MouseEvent(eventType, {
                                    bubbles: true,
                                    cancelable: true,
                                    view: window,
                                    detail: 1,
                                    clientX: coords.x,
                                    clientY: coords.y
                                  });
                                  element.dispatchEvent(event);
                                });
                                
                                // Also try the native click method
                                element.click();
                              }
                            }, { x: visibleElement.x, y: visibleElement.y });
                            console.log(`IPC: ✅ Vue event sequence dispatched`);
                          }
                        } catch (e) {
                          console.log(`IPC: All click methods failed: ${e.message}`);
                        }
                        
                        // Verify if the click had any effect by checking for DOM changes
                        await page.waitForTimeout(500); // Short wait for immediate effects
                        const afterClickCheck = await page.evaluate(() => {
                          return {
                            url: window.location.href,
                            title: document.title,
                            activeElement: document.activeElement?.tagName || 'none'
                          };
                        });
                        console.log(`IPC: After click state:`, afterClickCheck);
                        
                      } else {
                        console.log(`IPC: No visible element found with text: "${textToFind}"`);
                        // Fall back to the original selector
                        await page.click(action.selector, { timeout: 1000 });
                        console.log(`IPC: ✅ Used original selector as fallback`);
                      }
                    } catch (textError) {
                      console.log(`IPC: Text-based search failed: ${textError.message}`);
                      // Fall back to the original selector anyway
                      try {
                        await page.click(action.selector, { timeout: 1000 });
                        console.log(`IPC: ✅ Used original selector despite text issues`);
                      } catch (e) {
                        console.log(`IPC: Original selector also failed: ${e.message}`);
                      }
                    }
                  } else {
                    // Text matches or no text to compare - proceed with normal click
                    try {
                      await page.click(action.selector, { timeout: 1000 });
                      console.log(`IPC: ✅ Successfully clicked element: ${action.selector}`);
                    } catch (e) {
                      console.log(`IPC: page.click failed: ${e.message}`);
                      // Try manual click at element center
                      try {
                        const centerX = elementExists.rect.x + elementExists.rect.width / 2;
                        const centerY = elementExists.rect.y + elementExists.rect.height / 2;
                        await page.mouse.click(centerX, centerY);
                        console.log(`IPC: ✅ Manual click at element center: (${centerX}, ${centerY})`);
                      } catch (e2) {
                        console.log(`IPC: Manual click also failed: ${e2.message}`);
                      }
                    }
                  }
                } else if (elementExists.exists && !elementExists.visible) {
                  console.log(`IPC: Element exists but not visible: ${action.selector}`);
                } else {
                  console.log(`IPC: Element not found: ${action.selector}`);
                  // Fallback to coordinates
                  if (action.coordinates) {
                    await page.mouse.click(action.coordinates.x, action.coordinates.y);
                    console.log(`IPC: Used fallback coordinates: ${action.coordinates.x}, ${action.coordinates.y}`);
                  }
                }
              } else if (action.coordinates) {
                await page.mouse.click(action.coordinates.x, action.coordinates.y);
                console.log(`IPC: Clicked at coordinates: ${action.coordinates.x}, ${action.coordinates.y}`);
              }
              
            } else if (action.type === 'input') {
              if (action.selector && action.value) {
                try {
                  await page.fill(action.selector, action.value);
                  console.log(`IPC: Filled input: ${action.selector} = ${action.value}`);
                } catch (e) {
                  console.warn(`IPC: Failed to fill input: ${action.selector}`, e.message);
                }
              }
            } else if (action.type === 'scroll') {
              if (action.x !== undefined && action.y !== undefined) {
                await page.evaluate(({ x, y }) => {
                  window.scrollTo(x, y);
                }, { x: action.x, y: action.y });
                console.log(`IPC: Scrolled to: ${action.x}, ${action.y}`);
              }
            }
            
            // Wait longer between actions for Vue.js state changes
            console.log(`IPC: Waiting for Vue state to update after action ${i + 1}...`);
            await page.waitForTimeout(2000); // 2 seconds for Vue reactivity
            
            // Wait for any network activity to settle
            try {
              await page.waitForLoadState('networkidle', { timeout: 2000 });
              console.log(`IPC: Network settled after action ${i + 1}`);
            } catch (e) {
              console.log(`IPC: Network timeout after action ${i + 1} - continuing`);
            }
            
          } catch (error) {
            console.warn(`IPC: Failed to replay action ${i + 1} (${action.type}):`, error.message);
          }
        }
        
        // Wait longer so you can see the final state
        console.log('IPC: Waiting for actions to settle...');
        await page.waitForTimeout(3000);
      }
      
      console.log(`IPC: Taking screenshot at exact device dimensions ${width}x${height} @ ${deviceScaleFactor}x`);
      
      // Take screenshot at exact device viewport dimensions (not full page)
      // This gives us the exact App Store screenshot dimensions
      const screenshot = await page.screenshot({
        type: 'png',
        clip: {
          x: 0,
          y: 0,
          width: width,
          height: height
        }
      });
      
      await browser.close();
      
      console.log(`IPC: Screenshot captured, size: ${screenshot.length} bytes`);
      return screenshot;
      
    } catch (error) {
      console.error('IPC: Error in Puppeteer screenshot:', error);
      if (browser) {
        await browser.close();
      }
      throw error;
    }
  });
  
  // Handle high-resolution screenshot with HTML content
  ipcMain.handle('capture-high-res-screenshot-html', async (event, options) => {
    console.log('IPC: capture-high-res-screenshot-html called');
    const { htmlContent, width, height, deviceScaleFactor, userAgent, baseURL } = options;
    
    let offscreenWindow = null;
    
    try {
      // Calculate physical dimensions
      const physicalWidth = Math.ceil(width * deviceScaleFactor);
      const physicalHeight = Math.ceil(height * deviceScaleFactor);
      
      console.log(`IPC: Creating off-screen window ${physicalWidth}x${physicalHeight} (${width}x${height} @ ${deviceScaleFactor}x)`);
      
      // Create an off-screen window with exact dimensions
      offscreenWindow = new BrowserWindow({
        show: false,
        width: physicalWidth,
        height: physicalHeight,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          webSecurity: false,
          backgroundThrottling: false,
          offscreen: true
        },
        enableLargerThanScreen: true,
        frame: false,
        transparent: false,
        backgroundColor: '#ffffff'
      });

      // Set user agent if provided
      if (userAgent) {
        offscreenWindow.webContents.setUserAgent(userAgent);
      }

      // Set zoom factor for proper DPI rendering
      offscreenWindow.webContents.setZoomFactor(deviceScaleFactor);
      
      console.log('IPC: Loading HTML content with base URL:', baseURL);

      // Load the HTML content with proper base URL for resources
      await offscreenWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(htmlContent)}`, {
        baseURLForDataURL: baseURL || 'http://localhost:8080/'
      });
      
      // Wait for content to fully render
      await new Promise(resolve => {
        offscreenWindow.webContents.once('did-finish-load', () => {
          console.log('IPC: HTML content loaded');
          // Wait for any async rendering
          setTimeout(resolve, 1500);
        });
      });
      
      // Set viewport to logical dimensions
      await offscreenWindow.webContents.executeJavaScript(`
        document.documentElement.style.width = '${width}px';
        document.documentElement.style.height = '${height}px';
        document.body.style.width = '${width}px';
        document.body.style.height = '${height}px';
        document.body.style.margin = '0';
        document.body.style.padding = '0';
        true;
      `);
      
      // Wait a bit more for layout
      await new Promise(resolve => setTimeout(resolve, 500));
      
      console.log('IPC: Capturing page...');
      // Capture the full page
      const image = await offscreenWindow.webContents.capturePage();
      
      console.log('IPC: Converting to PNG...');
      // Convert to buffer
      const buffer = image.toPNG();

      // Close the window
      if (offscreenWindow && !offscreenWindow.isDestroyed()) {
        offscreenWindow.destroy();
      }
      
      console.log('IPC: Screenshot captured successfully');
      return buffer;
      
    } catch (error) {
      console.error('IPC: Error in capture-high-res-screenshot-html:', error);
      // Make sure to clean up the window
      if (offscreenWindow && !offscreenWindow.isDestroyed()) {
        offscreenWindow.destroy();
      }
      throw error;
    }
  });
  
  // Handle high-resolution screenshot requests (original, kept for compatibility)
  ipcMain.handle('capture-high-res-screenshot', async (event, options) => {
    console.log('IPC: capture-high-res-screenshot called with options:', options);
    const { url, width, height, deviceScaleFactor, userAgent } = options;
    
    let offscreenWindow = null;
    
    try {
      // Create an off-screen window
      console.log(`IPC: Creating off-screen window ${Math.ceil(width * deviceScaleFactor)}x${Math.ceil(height * deviceScaleFactor)}`);
      
      offscreenWindow = new BrowserWindow({
        show: false,
        width: Math.ceil(width * deviceScaleFactor),
        height: Math.ceil(height * deviceScaleFactor),
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          webSecurity: false,
          backgroundThrottling: false
        },
        enableLargerThanScreen: true,
        frame: false
      });

      // Set user agent if provided
      if (userAgent) {
        offscreenWindow.webContents.setUserAgent(userAgent);
      }

      // Set zoom factor for proper DPI rendering
      offscreenWindow.webContents.setZoomFactor(deviceScaleFactor);
      
      console.log(`IPC: Loading URL: ${url}`);

      // Create a timeout promise
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Page load timeout after 10 seconds')), 10000);
      });

      // Create a load promise
      const loadPromise = new Promise(async (resolve, reject) => {
        try {
          // Handle load failure
          offscreenWindow.webContents.once('did-fail-load', (event, errorCode, errorDescription) => {
            reject(new Error(`Failed to load: ${errorDescription} (${errorCode})`));
          });
          
          // Handle successful load
          offscreenWindow.webContents.once('did-finish-load', () => {
            console.log('IPC: Page loaded successfully');
            // Wait a bit for any dynamic content
            setTimeout(resolve, 1000);
          });
          
          // Load the URL
          await offscreenWindow.loadURL(url).catch(reject);
        } catch (error) {
          reject(error);
        }
      });

      // Wait for either load or timeout
      await Promise.race([loadPromise, timeoutPromise]);
      
      console.log('IPC: Capturing page...');
      // Capture the page
      const image = await offscreenWindow.webContents.capturePage();
      
      console.log('IPC: Converting to PNG...');
      // Convert to buffer
      const buffer = image.toPNG();

      // Close the window
      if (offscreenWindow && !offscreenWindow.isDestroyed()) {
        offscreenWindow.destroy();
      }
      
      console.log('IPC: Screenshot captured successfully');
      return buffer;
      
    } catch (error) {
      console.error('IPC: Error in capture-high-res-screenshot:', error);
      // Make sure to clean up the window
      if (offscreenWindow && !offscreenWindow.isDestroyed()) {
        offscreenWindow.destroy();
      }
      throw error;
    }
  });
}

// Manual screenshot mode - store browsers
let manualBrowsers = [];

// Handle opening manual browsers
ipcMain.handle('open-manual-browsers', async (event, options) => {
  console.log('IPC: Opening manual browsers for manual screenshot mode');
  const { url, devices, appState } = options;
  
  try {
    const { chromium } = require('playwright');
    const browsers = [];
    
    for (const device of devices) {
      console.log(`IPC: Opening ${device.name} browser (${device.width}x${device.height} @ ${device.deviceScaleFactor}x)`);
      
      const browser = await chromium.launch({
        headless: false, // Always visible for manual navigation
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-web-security',
          '--allow-running-insecure-content'
        ]
      });
      
      const context = await browser.newContext({
        viewport: {
          width: device.width,
          height: device.height
        },
        deviceScaleFactor: device.deviceScaleFactor
      });
      
      const page = await context.newPage();
      
      // Inject app state if provided
      if (appState) {
        console.log(`IPC: Injecting app state into ${device.name} browser...`);
        
        await page.addInitScript((injectedState) => {
          // Restore localStorage
          if (injectedState.localStorage) {
            for (const [key, value] of Object.entries(injectedState.localStorage)) {
              try {
                localStorage.setItem(key, value);
              } catch (e) {
                console.warn('Failed to set localStorage item:', key, e);
              }
            }
          }
          
          // Restore sessionStorage
          if (injectedState.sessionStorage) {
            for (const [key, value] of Object.entries(injectedState.sessionStorage)) {
              try {
                sessionStorage.setItem(key, value);
              } catch (e) {
                console.warn('Failed to set sessionStorage item:', key, e);
              }
            }
          }
          
          console.log('App state injected into manual browser:', 
            Object.keys(injectedState.localStorage || {}).length, 'localStorage items,',
            Object.keys(injectedState.sessionStorage || {}).length, 'sessionStorage items');
        }, appState);
      }
      
      await page.goto(url, { waitUntil: 'networkidle', timeout: 10000 });
      
      // Hide scrollbars for clean screenshots
      await page.addStyleTag({
        content: `
          /* Hide all scrollbars */
          * {
            scrollbar-width: none !important; /* Firefox */
            -ms-overflow-style: none !important; /* IE and Edge */
          }
          
          /* Hide webkit scrollbars (Chrome, Safari) */
          *::-webkit-scrollbar {
            display: none !important;
            width: 0 !important;
            height: 0 !important;
            background: transparent !important;
          }
          
          /* Ensure body and html have no overflow scrollbars */
          html, body {
            overflow-x: hidden !important;
            overflow-y: auto !important;
            scrollbar-width: none !important;
            -ms-overflow-style: none !important;
          }
          
          html::-webkit-scrollbar, body::-webkit-scrollbar {
            display: none !important;
          }
        `
      });
      
      // Wait for app to initialize with injected state
      await page.waitForTimeout(2000);
      
      console.log(`IPC: ${device.name} browser ready - scrollbars hidden`);
      
      browsers.push({
        browser,
        context,
        page,
        device
      });
    }
    
    manualBrowsers = browsers;
    
    return {
      success: true,
      browsers: browsers.map((b, i) => ({ id: i, device: b.device }))
    };
    
  } catch (error) {
    console.error('IPC: Error opening manual browsers:', error);
    return {
      success: false,
      error: error.message
    };
  }
});

// Handle capturing screenshots from manual browsers
ipcMain.handle('capture-manual-screenshots', async (event, options) => {
  console.log('IPC: Capturing screenshots from manual browsers');
  
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const screenshotsDir = require("path").join(process.cwd(), "screenshots");
    const fs = require("fs");
    
    if (!fs.existsSync(screenshotsDir)) {
      fs.mkdirSync(screenshotsDir);
    }
    
    const filenames = [];
    
    for (let i = 0; i < manualBrowsers.length; i++) {
      const { page, device } = manualBrowsers[i];
      
      console.log(`IPC: Taking screenshot of ${device.name} (${device.width}x${device.height} @ ${device.deviceScaleFactor}x)`);
      
      // Take screenshot at exact device dimensions
      const screenshot = await page.screenshot({
        type: 'png',
        clip: {
          x: 0,
          y: 0,
          width: device.width,
          height: device.height
        }
      });
      
      const dpiSuffix = device.deviceScaleFactor > 1 ? `_${device.deviceScaleFactor}x` : "";
      const deviceName = device.name.replace(/[^a-zA-Z0-9]/g, "_");
      const filename = `manual_${timestamp}_${deviceName}${dpiSuffix}.png`;
      const filepath = require("path").join(screenshotsDir, filename);
      
      fs.writeFileSync(filepath, screenshot);
      filenames.push(filename);
      
      console.log(`IPC: Saved ${filename}`);
    }
    
    // Automatically close all browsers after successful screenshots
    console.log('IPC: Auto-closing manual browsers after screenshots...');
    for (const { browser } of manualBrowsers) {
      try {
        if (browser && browser.isConnected()) {
          await browser.close();
        }
      } catch (e) {
        console.warn('IPC: Error closing browser:', e.message);
      }
    }
    
    manualBrowsers = [];
    console.log('IPC: All manual browsers closed');
    
    return {
      success: true,
      count: filenames.length,
      filenames,
      autoClosedBrowsers: true
    };
    
  } catch (error) {
    console.error('IPC: Error capturing manual screenshots:', error);
    
    // Still try to close browsers even on error
    console.log('IPC: Closing browsers due to error...');
    try {
      for (const { browser } of manualBrowsers) {
        if (browser && browser.isConnected()) {
          await browser.close();
        }
      }
      manualBrowsers = [];
    } catch (closeError) {
      console.warn('IPC: Error closing browsers after screenshot failure:', closeError.message);
    }
    
    return {
      success: false,
      error: error.message,
      autoClosedBrowsers: true
    };
  }
});

// Handle closing manual browsers
ipcMain.handle('close-manual-browsers', async (event) => {
  console.log('IPC: Closing manual browsers');
  
  try {
    for (const { browser } of manualBrowsers) {
      if (browser) {
        try {
          console.log('IPC: Closing browser...');
          await browser.close();
        } catch (closeError) {
          console.error('IPC: Error closing individual browser:', closeError);
          // Force kill the browser process if normal close fails
          try {
            if (browser._process) {
              browser._process.kill('SIGKILL');
            }
          } catch (killError) {
            console.error('IPC: Error force-killing browser:', killError);
          }
        }
      }
    }
    
    manualBrowsers = [];
    
    return { success: true };
    
  } catch (error) {
    console.error('IPC: Error closing manual browsers:', error);
    return {
      success: false,
      error: error.message
    };
  }
});

// Export mainWindow for use in IPC handlers
exports.getMainWindow = () => mainWindow;

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
