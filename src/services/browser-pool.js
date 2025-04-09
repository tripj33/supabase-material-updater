import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../utils/logger.js';

// Add stealth plugin to puppeteer
puppeteer.use(StealthPlugin());

// Get the directory name
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Browser Pool for efficient management of browser instances and pages
 */
class BrowserPool {
  constructor(options = {}) {
    this.browser = null;
    this.pages = {};
    this.maxPagesPerDomain = options.maxPagesPerDomain || 2;
    this.pageIdleTimeout = options.pageIdleTimeout || 30000; // 30 seconds
    this.pageTimers = {};
    this.onDisconnect = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = options.maxReconnectAttempts || 3;
    this.lastErrorTime = null;
    
    // Enhanced browser options for better stability
    this.initOptions = {
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--window-size=1280,800',
        '--disable-features=site-per-process',  // Prevents out of memory crashes
        '--disable-web-security',               // Can help with some sites
        '--disable-extensions',                 // Reduces memory usage
        '--disable-sync',                       // Reduces memory usage
        '--disable-background-networking',      // Reduces resource usage
        '--disable-default-apps',               // Reduces resource usage
        '--disable-translate',                  // Reduces resource usage
        '--disable-component-extensions-with-background-pages', // Reduces resource usage
        '--blink-settings=imagesEnabled=true'   // Only enable images when needed
      ],
      protocolTimeout: 60000,
      defaultViewport: { width: 1280, height: 800 },
      // Add these for better stability
      ignoreHTTPSErrors: true,
      timeout: 60000,
      // Handle process signals yourself
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
      // Output browser console to Node logs for debugging
      dumpio: true
    };
  }

  /**
   * Initialize the browser instance
   * @returns {Promise<Browser>} Puppeteer browser instance
   */
  async initialize() {
    if (this.browser) {
      return this.browser;
    }

    logger.info('Initializing browser pool');
    
    try {
      this.browser = await puppeteer.launch(this.initOptions);
      this.reconnectAttempts = 0;
      
      // Add enhanced error handler for browser disconnection
      this.browser.on('disconnected', () => {
        const now = new Date();
        
        // Log with current time for easier debugging
        logger.error(`Browser disconnected unexpectedly at ${now.toISOString()}`);
        
        // Track the time of the last error
        this.lastErrorTime = now;
        
        // Log memory usage at time of disconnect
        try {
          const memoryUsage = process.memoryUsage();
          logger.error(`Memory usage at disconnect: RSS: ${Math.round(memoryUsage.rss / 1024 / 1024)}MB, ` +
            `Heap Total: ${Math.round(memoryUsage.heapTotal / 1024 / 1024)}MB, ` +
            `Heap Used: ${Math.round(memoryUsage.heapUsed / 1024 / 1024)}MB`);
        } catch (error) {
          logger.warn(`Could not get memory usage: ${error.message}`);
        }
        
        // Don't nullify the browser here so that the recovery
        // system can detect the disconnection
        const wasInitialized = !!this.browser;
        
        // Cleanup resources but keep browser reference for detection
        this.cleanupResources();
        
        // Emit custom event for recovery system
        if (wasInitialized && typeof this.onDisconnect === 'function') {
          try {
            this.onDisconnect();
          } catch (error) {
            logger.error(`Error in disconnect handler: ${error.message}`);
          }
        }
      });
      
      logger.info('Browser pool initialized successfully');
      return this.browser;
    } catch (error) {
      logger.error(`Error initializing browser: ${error.message}`);
      throw error;
    }
  }

  /**
   * Set a handler function for browser disconnection events
   * @param {Function} handler - Disconnect handler function
   */
  setDisconnectHandler(handler) {
    if (typeof handler === 'function') {
      this.onDisconnect = handler;
      logger.info('Browser disconnect handler registered');
    } else {
      logger.warn('Invalid disconnect handler provided (not a function)');
    }
  }

  /**
   * Clean up resources without fully closing the browser
   * Useful for preparing for recovery
   */
  cleanupResources() {
    // Clear all page idle timers
    Object.keys(this.pageTimers).forEach(pageId => {
      clearTimeout(this.pageTimers[pageId]);
    });

    // Reset page tracking but keep browser reference
    this.pages = {};
    this.pageTimers = {};
  }

  /**
   * Get a page for a specific domain
   * @param {string} domain - Domain name
   * @returns {Promise<Page>} Puppeteer page wrapped in a proxy
   */
  async getPage(domain) {
    // Verify browser is initialized
    if (!this.browser) {
      logger.info('Browser not initialized, initializing now');
      await this.initialize();
    }
    
    // Verify browser is connected
    if (this.browser && !this.browser.isConnected()) {
      logger.warn('Browser is initialized but disconnected');
      throw new Error('Browser is disconnected');
    }
    
    if (!this.pages[domain]) {
      this.pages[domain] = [];
    }
    
    // Reuse an available page if one exists
    for (let i = 0; i < this.pages[domain].length; i++) {
      const pageData = this.pages[domain][i];
      
      if (!pageData.inUse) {
        logger.info(`Reusing existing page for domain: ${domain}`);
        
        // Clear any idle timer for this page
        if (this.pageTimers[pageData.id]) {
          clearTimeout(this.pageTimers[pageData.id]);
          delete this.pageTimers[pageData.id];
        }
        
        pageData.inUse = true;
        
        try {
          // Check if page is still responsive
          await pageData.page.evaluate(() => true);
          return this.createPageProxy(pageData, domain);
        } catch (error) {
          logger.warn(`Page is no longer responsive: ${error.message}`);
          
          // Remove from pages array
          this.pages[domain].splice(i, 1);
          i--;
          
          // Continue the loop to try another page or create a new one
        }
      }
    }
    
    // Create a new page if under the limit
    if (this.pages[domain].length < this.maxPagesPerDomain) {
      logger.info(`Creating new page for domain: ${domain}`);
      
      try {
        const page = await this.browser.newPage();
        const pageId = `${domain}-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
        
        // Configure the page
        await page.setUserAgent(
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        );
        
        // Higher timeout values for better stability with slow sites
        await page.setDefaultNavigationTimeout(90000); // 90 seconds
        await page.setDefaultTimeout(60000); // 60 seconds
        
        // Set request interception to block unwanted resources
        await page.setRequestInterception(true);
        page.on('request', (request) => {
          const resourceType = request.resourceType();
          if (['image', 'media', 'font', 'stylesheet'].includes(resourceType)) {
            request.abort();
          } else {
            request.continue();
          }
        });
        
        // Handle console messages
        page.on('console', (msg) => {
          if (msg.type() === 'error') {
            logger.debug(`Console error on ${domain}: ${msg.text()}`);
          }
        });
        
        // Handle page errors
        page.on('error', (err) => {
          logger.warn(`Page error on ${domain}: ${err.message}`);
        });

        // Handle JS errors in the page context
        page.on('pageerror', (err) => {
          logger.debug(`JS error on ${domain}: ${err.message}`);
        });

        // Handle dialog events (alerts, confirms, prompts)
        page.on('dialog', async (dialog) => {
          logger.info(`Dialog appeared on ${domain}: ${dialog.type()} - ${dialog.message()}`);
          await dialog.dismiss().catch(err => logger.warn(`Error dismissing dialog: ${err.message}`));
        });
        
        const pageData = { page, id: pageId, inUse: true, domain };
        this.pages[domain].push(pageData);
        
        return this.createPageProxy(pageData, domain);
      } catch (error) {
        // Check if error is related to browser disconnection
        if (error.message.includes('disconnected') || 
            error.message.includes('Target closed') ||
            error.message.includes('Session closed') ||
            error.message.includes('Protocol error') ||
            !this.browser || 
            (this.browser && !this.browser.isConnected())) {
          
          logger.error(`Browser disconnected during page creation: ${error.message}`);
          throw new Error(`Browser disconnection: ${error.message}`);
        }
        
        logger.error(`Error creating page for domain ${domain}: ${error.message}`);
        throw error;
      }
    }
    
    // Wait for a page to become available
    logger.info(`Waiting for a page to become available for domain: ${domain}`);
    
    return new Promise((resolve, reject) => {
      const checkInterval = setInterval(() => {
        // Verify browser is still connected
        if (!this.browser || (this.browser && !this.browser.isConnected())) {
          clearInterval(checkInterval);
          reject(new Error('Browser disconnected while waiting for available page'));
          return;
        }
        
        for (const pageData of this.pages[domain]) {
          if (!pageData.inUse) {
            clearInterval(checkInterval);
            
            // Clear any idle timer
            if (this.pageTimers[pageData.id]) {
              clearTimeout(this.pageTimers[pageData.id]);
              delete this.pageTimers[pageData.id];
            }
            
            pageData.inUse = true;
            
            try {
              // Check if page is still responsive
              pageData.page.evaluate(() => true)
                .then(() => resolve(this.createPageProxy(pageData, domain)))
                .catch(error => {
                  logger.warn(`Page is no longer responsive: ${error.message}`);
                  
                  // Remove from pages array
                  const index = this.pages[domain].indexOf(pageData);
                  if (index !== -1) {
                    this.pages[domain].splice(index, 1);
                  }
                  
                  // Try again
                  this.getPage(domain).then(resolve).catch(reject);
                });
            } catch (error) {
              logger.warn(`Error checking if page is responsive: ${error.message}`);
              
              // Remove from pages array
              const index = this.pages[domain].indexOf(pageData);
              if (index !== -1) {
                this.pages[domain].splice(index, 1);
              }
              
              // Try again
              this.getPage(domain).then(resolve).catch(reject);
            }
            
            return;
          }
        }
      }, 500); // Check every 500ms
      
      // Timeout after 30 seconds
      setTimeout(() => {
        clearInterval(checkInterval);
        reject(new Error(`Timeout waiting for available page for domain: ${domain}`));
      }, 30000);
    });
  }

  /**
   * Create a proxy for a page that adds a release method
   * @param {Object} pageData - Page data object
   * @param {string} domain - Domain name
   * @returns {Proxy} Proxy wrapping the page
   */
  createPageProxy(pageData, domain) {
    const originalPage = pageData.page;
    const self = this;
    
    const proxy = new Proxy(originalPage, {
      get(target, prop) {
        if (prop === 'release') {
          return function() {
            // Method to release the page back to the pool
            pageData.inUse = false;
            logger.debug(`Released page back to pool: ${pageData.id}`);
            
            // Set a timer to close the page if it remains unused
            self.pageTimers[pageData.id] = setTimeout(() => {
              logger.info(`Closing idle page for domain after timeout: ${domain}`);
              
              if (self.pages[domain]) {
                const index = self.pages[domain].findIndex(p => p.id === pageData.id);
                
                if (index !== -1 && !self.pages[domain][index].inUse) {
                  const pageToClose = self.pages[domain][index];
                  self.pages[domain].splice(index, 1);
                  
                  pageToClose.page.close()
                    .catch(error => {
                      logger.warn(`Error closing idle page: ${error.message}`);
                    });
                }
              }
              
              delete self.pageTimers[pageData.id];
            }, self.pageIdleTimeout);
          };
        } else if (prop === '_domain') {
          // Helper property to get the domain
          return domain;
        } else if (prop === '_id') {
          // Helper property to get the page ID
          return pageData.id;
        }
        
        return target[prop];
      }
    });
    
    return proxy;
  }

  /**
   * Close the browser and release all resources
   * @returns {Promise<void>}
   */
  async close() {
    if (this.browser) {
      logger.info('Closing browser pool');
      
      // Clear all page idle timers
      Object.keys(this.pageTimers).forEach(pageId => {
        clearTimeout(this.pageTimers[pageId]);
      });
      
      try {
        if (this.browser.isConnected()) {
          const pages = await this.browser.pages().catch(() => []);
          logger.info(`Closing ${pages.length} browser pages`);
          
          // Close all pages to avoid potential memory leaks
          for (const page of pages) {
            try {
              await page.close().catch(() => {});
            } catch (error) {
              logger.debug(`Error closing page: ${error.message}`);
            }
          }
          
          // Close the browser
          await this.browser.close();
          logger.info('Browser closed successfully');
        } else {
          logger.info('Browser already disconnected, skipping close');
        }
      } catch (error) {
        logger.warn(`Error closing browser: ${error.message}`);
      }
      
      this.browser = null;
      this.pages = {};
      this.pageTimers = {};
      
      logger.info('Browser pool closed and resources released');
    } else {
      logger.info('No browser instance to close');
    }
  }
  
  /**
   * Get number of pages currently in use
   * @returns {number} Count of pages in use
   */
  getPagesInUseCount() {
    let count = 0;
    
    for (const domain in this.pages) {
      for (const pageData of this.pages[domain]) {
        if (pageData.inUse) {
          count++;
        }
      }
    }
    
    return count;
  }
  
  /**
   * Get total number of pages
   * @returns {number} Total count of pages
   */
  getTotalPagesCount() {
    let count = 0;
    
    for (const domain in this.pages) {
      count += this.pages[domain].length;
    }
    
    return count;
  }
  
  /**
   * Get status of browser pool
   * @returns {Object} Status information
   */
  getStatus() {
    const isConnected = this.browser ? this.browser.isConnected() : false;
    
    return {
      initialized: !!this.browser,
      connected: isConnected,
      totalPages: this.getTotalPagesCount(),
      pagesInUse: this.getPagesInUseCount(),
      domains: Object.keys(this.pages).length,
      reconnectAttempts: this.reconnectAttempts,
      lastErrorTime: this.lastErrorTime ? this.lastErrorTime.toISOString() : null,
      memoryUsage: process.memoryUsage().heapUsed / 1024 / 1024, // MB
    };
  }
}

export default new BrowserPool();