// main.js - Electron Main Process
const { app, BrowserWindow, ipcMain, session } = require("electron");
const path = require("path");
const fs = require("fs");

let mainWindow;

app.whenReady().then(() => {
  createMainWindow();
  setupIPCHandlers();
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
  
  // Handle Puppeteer-based screenshot
  ipcMain.handle('capture-puppeteer-screenshot', async (event, options) => {
    console.log('IPC: capture-puppeteer-screenshot called');
    const { url, width, height, deviceScaleFactor, userAgent } = options;
    
    const puppeteer = require('puppeteer');
    let browser = null;
    
    try {
      console.log(`IPC: Launching Puppeteer for ${width}x${height} @ ${deviceScaleFactor}x`);
      
      // Launch browser
      browser = await puppeteer.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-web-security',
          '--allow-running-insecure-content'
        ]
      });
      
      const page = await browser.newPage();
      
      // Set user agent if provided
      if (userAgent) {
        await page.setUserAgent(userAgent);
      }
      
      // Set viewport to physical dimensions for proper App Store resolution
      const physicalWidth = width * deviceScaleFactor;
      const physicalHeight = height * deviceScaleFactor;
      
      console.log(`IPC: Setting viewport to physical dimensions ${physicalWidth}x${physicalHeight} (${width}x${height} logical @ ${deviceScaleFactor}x)`);
      
      await page.setViewport({
        width: physicalWidth,
        height: physicalHeight,
        deviceScaleFactor: 1 // Don't zoom, we're already at physical size
      });
      
      // Inject CSS to make the page render as if it were the logical dimensions
      await page.evaluateOnNewDocument((logicalWidth, logicalHeight) => {
        const style = document.createElement('style');
        style.textContent = `
          html {
            width: ${logicalWidth}px !important;
            min-width: ${logicalWidth}px !important;
            max-width: ${logicalWidth}px !important;
          }
          body {
            width: ${logicalWidth}px !important;
            min-width: ${logicalWidth}px !important;
            max-width: ${logicalWidth}px !important;
            zoom: ${physicalWidth / logicalWidth};
          }
          * {
            max-width: ${logicalWidth}px !important;
          }
        `;
        document.head.appendChild(style);
      }, width, height);
      
      console.log(`IPC: Loading ${url}`);
      
      // Navigate to URL
      await page.goto(url, {
        waitUntil: 'networkidle0',
        timeout: 10000
      });
      
      // Wait a bit for any dynamic content
      await page.waitForTimeout(1000);
      
      // Get the actual content dimensions
      const contentSize = await page.evaluate(() => {
        return {
          scrollWidth: document.documentElement.scrollWidth,
          scrollHeight: document.documentElement.scrollHeight,
          clientWidth: document.documentElement.clientWidth,
          clientHeight: document.documentElement.clientHeight
        };
      });
      
      console.log(`IPC: Content size: ${contentSize.scrollWidth}x${contentSize.scrollHeight}, Viewport: ${contentSize.clientWidth}x${contentSize.clientHeight}`);
      
      // Calculate how many viewport-height tiles we need to capture the full content
      const tilesNeeded = Math.ceil(contentSize.scrollHeight / physicalHeight);
      console.log(`IPC: Need ${tilesNeeded} tiles of ${physicalWidth}x${physicalHeight} each`);
      
      const tiles = [];
      
      // Capture tiles by scrolling
      for (let i = 0; i < tilesNeeded; i++) {
        const scrollY = i * physicalHeight;
        
        // Scroll to position (scale down for logical scrolling)
        await page.evaluate((y, scale) => {
          window.scrollTo(0, y / scale);
        }, scrollY, deviceScaleFactor);
        
        // Wait for scroll to settle
        await page.waitForTimeout(200);
        
        // Capture this viewport at full physical dimensions
        const tileScreenshot = await page.screenshot({
          type: 'png',
          clip: {
            x: 0,
            y: 0,
            width: physicalWidth,
            height: Math.min(physicalHeight, contentSize.scrollHeight * deviceScaleFactor - scrollY)
          }
        });
        
        tiles.push({
          buffer: tileScreenshot,
          y: scrollY,
          height: Math.min(physicalHeight, contentSize.scrollHeight * deviceScaleFactor - scrollY)
        });
        
        console.log(`IPC: Captured tile ${i + 1}/${tilesNeeded} at scroll position ${scrollY}`);
      }
      
      // If only one tile, return it directly
      if (tiles.length === 1) {
        await browser.close();
        console.log(`IPC: Single tile capture complete`);
        return tiles[0].buffer;
      }
      
      // Stitch tiles together using Canvas
      const { createCanvas, Image } = require('canvas');
      
      const finalHeight = contentSize.scrollHeight * deviceScaleFactor;
      const canvasWidth = physicalWidth;
      const canvasHeight = Math.ceil(finalHeight);
      
      console.log(`IPC: Stitching ${tiles.length} tiles into ${canvasWidth}x${canvasHeight} canvas`);
      
      const canvas = createCanvas(canvasWidth, canvasHeight);
      const ctx = canvas.getContext('2d');
      
      // Set white background
      ctx.fillStyle = 'white';
      ctx.fillRect(0, 0, canvasWidth, canvasHeight);
      
      // Draw each tile
      for (const tile of tiles) {
        const img = new Image();
        img.src = tile.buffer;
        
        const y = tile.y;
        ctx.drawImage(img, 0, y);
        
        console.log(`IPC: Drew tile at y=${y}`);
      }
      
      const screenshot = canvas.toBuffer('image/png');
      
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

// Export mainWindow for use in IPC handlers
exports.getMainWindow = () => mainWindow;

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
