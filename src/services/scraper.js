import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

// Add stealth plugin to puppeteer
puppeteer.use(StealthPlugin());
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { logger } from '../utils/logger.js';

// Load environment variables
dotenv.config();

// Get the directory name
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const screenshotsDir = path.join(__dirname, '../../screenshots');

// Ensure screenshots directory exists
if (!fs.existsSync(screenshotsDir)) {
  fs.mkdirSync(screenshotsDir, { recursive: true });
}

// Site credentials
const WINSUPPLY_EMAIL = process.env.WINSUPPLY_EMAIL;
const WINSUPPLY_PASSWORD = process.env.WINSUPPLY_PASSWORD;

const HOMEDEPOT_EMAIL = process.env.HOMEDEPOT_EMAIL;
const HOMEDEPOT_PASSWORD = process.env.HOMEDEPOT_PASSWORD;

const HDSUPPLY_EMAIL = process.env.HDSUPPLY_EMAIL;
const HDSUPPLY_PASSWORD = process.env.HDSUPPLY_PASSWORD;

const SUPPLYHOUSE_EMAIL = process.env.SUPPLYHOUSE_EMAIL;
const SUPPLYHOUSE_PASSWORD = process.env.SUPPLYHOUSE_PASSWORD;

// Check for required credentials
if (!WINSUPPLY_EMAIL || !WINSUPPLY_PASSWORD) {
  logger.error('WinSupply credentials are missing in environment variables');
  // Not exiting here as we can still function with some vendors missing
}

if (!HOMEDEPOT_EMAIL || !HOMEDEPOT_PASSWORD) {
  logger.error('Home Depot credentials are missing in environment variables');
  // Not exiting here as we can still function with some vendors missing
}

if (!HDSUPPLY_EMAIL || !HDSUPPLY_PASSWORD) {
  logger.error('HD Supply credentials are missing in environment variables');
  // Not exiting here as we can still function with some vendors missing
}

if (!SUPPLYHOUSE_EMAIL || !SUPPLYHOUSE_PASSWORD) {
  logger.error('SupplyHouse credentials are missing in environment variables');
  // Not exiting here as we can still function with some vendors missing
}

/**
 * Service for web scraping with Puppeteer
 */
class ScraperService {
  constructor() {
    this.browser = null;
    this.pages = {};
    this.loggedInDomains = new Set();
  }

  /**
   * Initialize the browser
   */
  async initialize() {
    try {
      logger.info('Initializing Puppeteer browser');
      this.browser = await puppeteer.launch({
        // headless: false, // Set to false to make the browser visible
        args: [
          '--no-sandbox', 
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--disable-gpu',
          '--window-size=1280,800'
        ],
        protocolTimeout: 60000, // Set protocol timeout to 60 seconds
        defaultViewport: { width: 1280, height: 800 }
      });
      
      // Add error handler for browser disconnection
      this.browser.on('disconnected', async () => {
        logger.error('Browser disconnected unexpectedly');
        this.browser = null;
        this.pages = {};
        this.loggedInDomains = new Set();
        
        // Wait a bit before attempting to reinitialize
        await new Promise(resolve => setTimeout(resolve, 5000));
        
        // Don't auto-reinitialize, let the next operation handle it
        logger.info('Browser disconnected - will reinitialize on next operation');
      });
      
      logger.info('Puppeteer browser initialized');
    } catch (error) {
      logger.error(`Error initializing browser: ${error.message}`);
      throw error;
    }
  }

  /**
   * Close the browser
   */
  async close() {
    if (this.browser) {
      logger.info('Closing Puppeteer browser');
      await this.browser.close();
      this.browser = null;
      this.pages = {};
      this.loggedInDomains = new Set();
      logger.info('Puppeteer browser closed');
    }
  }

  /**
   * Get or create a page for a specific domain
   * @param {string} domain - The domain name
   * @returns {Promise<Page>} Puppeteer page object
   */
  async getPage(domain) {
    // Make sure we have a browser instance
    if (!this.browser) {
      await this.initialize();
    }

    try {
      // If we already have a page for this domain and it's not closed, return it
      if (this.pages[domain]) {
        // Check if the page is still valid
        try {
          // Simple test to see if page is still responsive
          await this.pages[domain].evaluate(() => true);
          return this.pages[domain];
        } catch (error) {
          logger.warn(`Page for ${domain} is no longer responsive: ${error.message}`);
          delete this.pages[domain];
          // Continue with getting a new page
        }
      }
      
      // Close ALL open pages before creating a new one
      const openDomains = Object.keys(this.pages);
      
      // Close all existing pages
      if (openDomains.length > 0) {
        logger.info(`Ensuring only one tab is open. Closing all existing tabs.`);
        
        for (const oldDomain of openDomains) {
          // Close the page
          try {
            await this.pages[oldDomain].close();
            logger.info(`Closed page for domain: ${oldDomain}`);
          } catch (error) {
            logger.warn(`Error closing page for domain ${oldDomain}: ${error.message}`);
          }
          
          // Remove from pages object
          delete this.pages[oldDomain];
        }
      }
      
      // If browser has crashed or disconnected, reinitialize
      if (!this.browser) {
        logger.info('Browser appears to be disconnected, reinitializing...');
        await this.initialize();
      }
      
      // Create a new page for this domain with retry
      let retries = 0;
      const maxRetries = 3;
      let lastError = null;
      
      while (retries < maxRetries) {
        try {
          logger.info(`Creating new page for domain: ${domain} (attempt ${retries + 1}/${maxRetries})`);
          this.pages[domain] = await this.browser.newPage();
          
          // Set user agent
          await this.pages[domain].setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
          );
          
          // Add error handler for page crash
          this.pages[domain].on('error', (err) => {
            logger.error(`Page for ${domain} crashed: ${err.message}`);
            delete this.pages[domain];
          });
          
          // Add additional page settings to improve stability
          await this.pages[domain].setCacheEnabled(true);
          await this.pages[domain].setDefaultNavigationTimeout(90000); // 90 seconds
          await this.pages[domain].setDefaultTimeout(30000); // 30 seconds for other operations
          
          // Set request interception to block unwanted resources
          await this.pages[domain].setRequestInterception(true);
          this.pages[domain].on('request', (request) => {
            const resourceType = request.resourceType();
            // Block unnecessary resource types to reduce browser load
            if (['image', 'media', 'font', 'stylesheet'].includes(resourceType)) {
              request.abort();
            } else {
              request.continue();
            }
          });
          
          return this.pages[domain];
        } catch (error) {
          lastError = error;
          logger.warn(`Failed to create page for ${domain}: ${error.message}. Retrying (${retries + 1}/${maxRetries})`);
          retries++;
          
          // Wait before retrying
          await new Promise(resolve => setTimeout(resolve, 2000));
          
          // If browser has crashed, reinitialize
          if (!this.browser) {
            logger.info('Browser crashed during page creation, reinitializing...');
            await this.initialize();
          }
        }
      }
      
      // If we reached here, all retries failed
      throw lastError || new Error(`Failed to create page for ${domain} after ${maxRetries} attempts`);
    } catch (error) {
      logger.error(`Fatal error getting page for ${domain}: ${error.message}`);
      
      // Attempt recovery by closing and reinitializing the browser
      try {
        await this.close();
        logger.info('Closed browser after fatal error. Will reinitialize on next operation.');
      } catch (closeError) {
        logger.error(`Error closing browser: ${closeError.message}`);
      }
      
      throw error;
    }
  }

  /**
   * Extract domain from URL
   * @param {string} url - The URL
   * @returns {string} Domain name
   */
  extractDomain(url) {
    try {
      const urlObj = new URL(url);
      return urlObj.hostname;
    } catch (error) {
      logger.error(`Error extracting domain from URL ${url}: ${error.message}`);
      return url;
    }
  }

  /**
   * Login to WinSupply
   * @returns {Promise<boolean>} Success status
   */
  async loginToWinSupply() {
    try {
      const domain = 'winsupplyinc.com';
      
      if (this.loggedInDomains.has(domain)) {
        logger.info('Already logged in to WinSupply');
        return true;
      }
      
      logger.info('Logging in to WinSupply');
      const page = await this.getPage(domain);
      
      // Navigate to login page with retry
      let retries = 0;
      const maxRetries = 3;
      
      while (retries < maxRetries) {
        try {
          await page.goto('https://www.winsupplyinc.com/account/login', {
            waitUntil: 'networkidle2',
            timeout: 60000
          });
          
          // Check if we're on the login page
          const emailFieldExists = await page.$('#email_field') !== null;
          
          if (emailFieldExists) {
            break; // Successfully loaded login page
          } else {
            logger.warn(`Login page not loaded correctly, retrying (${retries + 1}/${maxRetries})`);
            retries++;
            await page.waitForTimeout(2000);
          }
        } catch (error) {
          logger.warn(`Error loading login page, retrying (${retries + 1}/${maxRetries}): ${error.message}`);
          retries++;
          await page.waitForTimeout(2000);
          
          if (retries >= maxRetries) {
            throw error;
          }
        }
      }
      
      // Fill in login form with human-like typing
      logger.info('Filling in WinSupply login form');
      await this.typeHumanLike(page, '#email_field', WINSUPPLY_EMAIL);
      
      await this.typeHumanLike(page, '#si_password', WINSUPPLY_PASSWORD);
      
      // Click login button with random delay
      logger.info('Submitting WinSupply login form');
      await this.randomDelayBeforeClick(page, '.c-button--sign-in.win-btn.win-btn-secondary');
      
      // Wait for login to complete
      logger.info('Waiting for WinSupply login to complete');
      await page.waitForTimeout(5000); // Increased wait time
      
      // Check if login was successful
      const currentUrl = page.url();
      const loginSuccess = !currentUrl.includes('/account/login');
      
      if (loginSuccess) {
        logger.info('Successfully logged in to WinSupply');
        this.loggedInDomains.add(domain);
        
        // Take a screenshot of the logged-in state for debugging
        const screenshotPath = path.join(screenshotsDir, `winsupply_login_success_${Date.now()}.jpg`);
        await page.screenshot({ path: screenshotPath, type: 'jpeg', quality: 80 });
        logger.info(`Saved WinSupply login screenshot to ${screenshotPath}`);
        
        return true;
      } else {
        logger.error('Failed to log in to WinSupply - still on login page');
        
        // Take a screenshot of the failed login for debugging
        const screenshotPath = path.join(screenshotsDir, `winsupply_login_failed_${Date.now()}.jpg`);
        await page.screenshot({ path: screenshotPath, type: 'jpeg', quality: 80 });
        logger.error(`Saved failed login screenshot to ${screenshotPath}`);
        
        return false;
      }
    } catch (error) {
      logger.error(`Error logging in to WinSupply: ${error.message}`);
      return false;
    }
  }

  /**
   * Login to Home Depot
   * @returns {Promise<boolean>} Success status
   */
  async loginToHomeDepot() {
    try {
      const domain = 'homedepot.com';
      
      if (this.loggedInDomains.has(domain)) {
        logger.info('Already logged in to Home Depot');
        return true;
      }
      
      logger.info('Logging in to Home Depot');
      const page = await this.getPage(domain);
      
      // Navigate to login page
      await page.goto('https://www.homedepot.com/auth/view/signin', {
        waitUntil: 'networkidle2',
        timeout: 60000
      });
      
      // Fill in email with human-like typing
      logger.info('Filling in Home Depot email');
      await this.typeHumanLike(page, '#username', HOMEDEPOT_EMAIL);
      
      // Click continue button with random delay
      logger.info('Clicking continue button');
      await this.randomDelayBeforeClick(page, '#sign-in-button');
      
      // Wait for the "No Thanks" button and click it if it appears
      await page.waitForTimeout(1000);
      try {
        const noThanksButton = await page.$x("//button[contains(text(), 'No Thanks')]");
        if (noThanksButton.length > 0) {
          logger.info('Clicking "No Thanks" button');
          
          // Random delay before clicking No Thanks
          const clickDelay = Math.floor(Math.random() * 700) + 500;
          logger.info(`Waiting ${clickDelay}ms before clicking No Thanks (human-like delay)`);
          await page.waitForTimeout(clickDelay);
          
          await noThanksButton[0].click();
          await page.waitForTimeout(1000);
        }
      } catch (error) {
        logger.warn(`No "No Thanks" button found: ${error.message}`);
      }
      
      // Fill in password with human-like typing
      logger.info('Filling in Home Depot password');
      await this.typeHumanLike(page, '#password-input-field', HOMEDEPOT_PASSWORD);
      
      // Click sign in button with random delay
      logger.info('Clicking sign in button');
      await this.randomDelayBeforeClick(page, '#sign-in-button');
      
      // Wait for login to complete
      await page.waitForTimeout(5000);
      
      // Check if login was successful
      const currentUrl = page.url();
      const loginSuccess = !currentUrl.includes('/auth/view/signin');
      
      if (loginSuccess) {
        logger.info('Successfully logged in to Home Depot');
        this.loggedInDomains.add(domain);
        
        // Take a screenshot of the logged-in state for debugging
        const screenshotPath = path.join(screenshotsDir, `homedepot_login_success_${Date.now()}.jpg`);
        await page.screenshot({ path: screenshotPath, type: 'jpeg', quality: 80 });
        logger.info(`Saved Home Depot login screenshot to ${screenshotPath}`);
        
        return true;
      } else {
        logger.error('Failed to log in to Home Depot');
        
        // Take a screenshot of the failed login for debugging
        const screenshotPath = path.join(screenshotsDir, `homedepot_login_failed_${Date.now()}.jpg`);
        await page.screenshot({ path: screenshotPath, type: 'jpeg', quality: 80 });
        logger.error(`Saved failed login screenshot to ${screenshotPath}`);
        
        return false;
      }
    } catch (error) {
      logger.error(`Error logging in to Home Depot: ${error.message}`);
      return false;
    }
  }

  /**
   * Type text with variable speed like a human
   * @param {Page} page - Puppeteer page object
   * @param {string} selector - CSS selector for the input field
   * @param {string} text - Text to type
   */
  async typeHumanLike(page, selector, text) {
    await page.waitForSelector(selector, { timeout: 10000 });
    
    // Focus on the input field
    await page.focus(selector);
    
    // Type each character with variable delay
    for (const char of text) {
      // Random delay between 50ms and 200ms for typing
      const typeDelay = Math.floor(Math.random() * 150) + 50;
      await page.waitForTimeout(typeDelay);
      await page.keyboard.type(char);
    }
  }
  
  /**
   * Add random delay before clicking
   * @param {Page} page - Puppeteer page object
   * @param {string} selector - CSS selector for the element to click
   */
  async randomDelayBeforeClick(page, selector) {
    await page.waitForSelector(selector, { timeout: 10000 });
    
    // Random delay between 0.5 and 1.2 seconds
    const clickDelay = Math.floor(Math.random() * 700) + 500;
    logger.info(`Waiting ${clickDelay}ms before clicking (human-like delay)`);
    await page.waitForTimeout(clickDelay);
    
    await page.click(selector);
  }

  /**
   * Login to HD Supply (ebarnett.com)
   * @returns {Promise<boolean>} Success status
   */
  async loginToHDSupply() {
    try {
      const domain = 'ebarnett.com';
      
      if (this.loggedInDomains.has(domain)) {
        logger.info('Already logged in to HD Supply');
        return true;
      }
      
      logger.info('Logging in to HD Supply');
      const page = await this.getPage(domain);
      
      // Navigate to login page
      await page.goto('https://www.ebarnett.com', {
        waitUntil: 'networkidle2',
        timeout: 60000
      });
      
      // Fill in username with human-like typing
      logger.info('Filling in HD Supply username');
      await this.typeHumanLike(page, 'input#UserName', HDSUPPLY_EMAIL);
      
      // Fill in password with human-like typing
      logger.info('Filling in HD Supply password');
      await this.typeHumanLike(page, 'input#Password', HDSUPPLY_PASSWORD);
      
      // Click login button with random delay
      logger.info('Clicking login button');
      await this.randomDelayBeforeClick(page, 'input#login-box-submit-buttom');
      
      // Wait for login to complete
      await page.waitForTimeout(2000);
      
      // Check if login was successful (this is a simple check, might need adjustment)
      const loginSuccess = await page.evaluate(() => {
        return !document.querySelector('input#UserName');
      });
      
      if (loginSuccess) {
        logger.info('Successfully logged in to HD Supply');
        this.loggedInDomains.add(domain);
        
        // Take a screenshot of the logged-in state for debugging
        const screenshotPath = path.join(screenshotsDir, `hdsupply_login_success_${Date.now()}.jpg`);
        await page.screenshot({ path: screenshotPath, type: 'jpeg', quality: 80 });
        logger.info(`Saved HD Supply login screenshot to ${screenshotPath}`);
        
        return true;
      } else {
        logger.error('Failed to log in to HD Supply');
        
        // Take a screenshot of the failed login for debugging
        const screenshotPath = path.join(screenshotsDir, `hdsupply_login_failed_${Date.now()}.jpg`);
        await page.screenshot({ path: screenshotPath, type: 'jpeg', quality: 80 });
        logger.error(`Saved failed login screenshot to ${screenshotPath}`);
        
        return false;
      }
    } catch (error) {
      logger.error(`Error logging in to HD Supply: ${error.message}`);
      return false;
    }
  }

  /**
   * Login to SupplyHouse.com
   * @returns {Promise<boolean>} Success status
   */
  async loginToSupplyHouse() {
    try {
      const domain = 'supplyhouse.com';
      
      if (this.loggedInDomains.has(domain)) {
        logger.info('Already logged in to SupplyHouse.com');
        return true;
      }
      
      logger.info('Logging in to SupplyHouse.com');
      const page = await this.getPage(domain);
      
      // Navigate to login page
      await page.goto('https://www.supplyhouse.com/sh/control/login', {
        waitUntil: 'networkidle2',
        timeout: 60000
      });
      
      // Fill in username with human-like typing
      logger.info('Filling in SupplyHouse.com username');
      await this.typeHumanLike(page, 'input#username', SUPPLYHOUSE_EMAIL);
      
      // Fill in password with human-like typing
      logger.info('Filling in SupplyHouse.com password');
      await this.typeHumanLike(page, 'input#password', SUPPLYHOUSE_PASSWORD);
      
      // Click sign in button with random delay
      logger.info('Clicking sign in button');
      await this.randomDelayBeforeClick(page, 'button.btn.btn-lg.btn-block.button-blue.bold.upper');
      
      // Wait for login to complete
      await page.waitForTimeout(2000);
      
      // Check if login was successful
      const loginSuccess = await page.evaluate(() => {
        return !document.querySelector('input#username');
      });
      
      if (loginSuccess) {
        logger.info('Successfully logged in to SupplyHouse.com');
        this.loggedInDomains.add(domain);
        
        // Take a screenshot of the logged-in state for debugging
        const screenshotPath = path.join(screenshotsDir, `supplyhouse_login_success_${Date.now()}.jpg`);
        await page.screenshot({ path: screenshotPath, type: 'jpeg', quality: 80 });
        logger.info(`Saved SupplyHouse.com login screenshot to ${screenshotPath}`);
        
        return true;
      } else {
        logger.error('Failed to log in to SupplyHouse.com');
        
        // Take a screenshot of the failed login for debugging
        const screenshotPath = path.join(screenshotsDir, `supplyhouse_login_failed_${Date.now()}.jpg`);
        await page.screenshot({ path: screenshotPath, type: 'jpeg', quality: 80 });
        logger.error(`Saved failed login screenshot to ${screenshotPath}`);
        
        return false;
      }
    } catch (error) {
      logger.error(`Error logging in to SupplyHouse.com: ${error.message}`);
      return false;
    }
  }

  /**
   * Handle common popups and overlays on vendor websites
   * @param {Page} page - Puppeteer page object
   * @param {string} domain - The domain name
   */
  async handleCommonPopups(page, domain) {
    try {
      // Handle cookie consent banners (common on many sites)
      const cookieSelectors = [
        'button[aria-label="Accept cookies"]',
        'button[aria-label="Accept all cookies"]',
        'button.cookie-accept',
        'button.accept-cookies',
        '[id*="cookie"] button',
        '[class*="cookie"] button',
        'button:not([aria-hidden="true"]):not([tabindex="-1"]):not([style*="display: none"]):not([style*="visibility: hidden"]):not([style*="opacity: 0"]):not([disabled])[id*="accept"]',
        'button:not([aria-hidden="true"]):not([tabindex="-1"]):not([style*="display: none"]):not([style*="visibility: hidden"]):not([style*="opacity: 0"]):not([disabled])[class*="accept"]'
      ];
      
      for (const selector of cookieSelectors) {
        if (await page.$(selector) !== null) {
          logger.info(`Clicking cookie consent button: ${selector}`);
          await page.click(selector).catch(() => {});
          await page.waitForTimeout(1000);
          break;
        }
      }
      
      // Handle location/zip code popups (common on Home Depot, Lowe's, etc.)
      if (domain.includes('homedepot.com') || domain.includes('lowes.com')) {
        const zipCodeSelectors = [
          'button[aria-label="Continue"]',
          'button.location-continue',
          'button.zip-code-continue',
          'button:not([aria-hidden="true"]):not([tabindex="-1"]):not([style*="display: none"]):not([style*="visibility: hidden"]):not([style*="opacity: 0"]):not([disabled])[id*="continue"]',
          'button:not([aria-hidden="true"]):not([tabindex="-1"]):not([style*="display: none"]):not([style*="visibility: hidden"]):not([style*="opacity: 0"]):not([disabled])[class*="continue"]'
        ];
        
        for (const selector of zipCodeSelectors) {
          if (await page.$(selector) !== null) {
            logger.info(`Clicking location/zip code button: ${selector}`);
            await page.click(selector).catch(() => {});
            await page.waitForTimeout(1000);
            break;
          }
        }
      }
      
      // Handle newsletter/signup popups (common on many sites)
      const closePopupSelectors = [
        'button[aria-label="Close"]',
        'button.modal-close',
        'button.popup-close',
        'button.newsletter-close',
        'button:not([aria-hidden="true"]):not([tabindex="-1"]):not([style*="display: none"]):not([style*="visibility: hidden"]):not([style*="opacity: 0"]):not([disabled])[id*="close"]',
        'button:not([aria-hidden="true"]):not([tabindex="-1"]):not([style*="display: none"]):not([style*="visibility: hidden"]):not([style*="opacity: 0"]):not([disabled])[class*="close"]',
        'svg[aria-label="Close"]'
      ];
      
      for (const selector of closePopupSelectors) {
        if (await page.$(selector) !== null) {
          logger.info(`Closing popup: ${selector}`);
          await page.click(selector).catch(() => {});
          await page.waitForTimeout(1000);
          break;
        }
      }
    } catch (error) {
      logger.warn(`Error handling popups: ${error.message}`);
      // Continue anyway, this is just a best-effort attempt
    }
  }

/**
 * Take a screenshot of a product page with improved error handling
 * @param {string} url - The URL of the product page
 * @param {string} itemId - The ID of the item (for filename)
 * @returns {Promise<string|null>} Path to the screenshot or null if failed
 */
async takeScreenshot(url, itemId) {
  let retries = 0;
  const maxRetries = 2;
  let page = null;
  
  while (retries <= maxRetries) {
    try {
      const domain = this.extractDomain(url);
      logger.info(`Taking screenshot of ${url} (attempt ${retries + 1}/${maxRetries + 1})`);
      
      // Check if we need to skip URLs for domains we're not logged into
      // Note: HD Supply (ebarnett.com) doesn't require login to view product pages
      const domainChecks = [
        { domain: 'winsupplyinc.com', loginDomain: 'winsupplyinc.com', name: 'WinSupply', requiresLogin: true },
        { domain: 'homedepot.com', loginDomain: 'homedepot.com', name: 'Home Depot', requiresLogin: false },
        { domain: 'ebarnett.com', loginDomain: 'ebarnett.com', name: 'HD Supply', requiresLogin: false },
        { domain: 'supplyhouse.com', loginDomain: 'supplyhouse.com', name: 'SupplyHouse.com', requiresLogin: false }
      ];
      
      // Find the matching domain check
      const domainCheck = domainChecks.find(check => domain.includes(check.domain));
      
      // If this is a domain that requires login and we're not logged in, skip it
      if (domainCheck && domainCheck.requiresLogin && !this.loggedInDomains.has(domainCheck.loginDomain)) {
        logger.error(`Cannot process ${domainCheck.name} URL: ${url} - not logged in`);
        return null;
      }
      
      // Get a new page for this request to avoid "Request is already handled" errors
      try {
        // If we're retrying, make sure the previous page is closed
        if (page) {
          await page.close().catch(e => logger.warn(`Error closing previous page: ${e.message}`));
          page = null;
        }
        
        // Create a new browser page with a specific ID to track it
        page = await this.browser.newPage();
        const pageId = Date.now() + Math.random().toString(36).substring(2, 15);
        logger.info(`Created new page ${pageId} for ${url}`);
        
        // Set user agent
        await page.setUserAgent(
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        );
        
        // Set request interception to block unwanted resources
        await page.setRequestInterception(true);
        page.on('request', (request) => {
          const resourceType = request.resourceType();
          // Block unnecessary resource types to reduce browser load
          if (['image', 'media', 'font', 'stylesheet'].includes(resourceType)) {
            request.abort();
          } else {
            request.continue();
          }
        });
        
        // Set timeouts
        await page.setDefaultNavigationTimeout(60000); // 60 seconds
        await page.setDefaultTimeout(30000); // 30 seconds
        
        // Configure error handling
        page.on('error', (err) => {
          logger.error(`Page error for ${url}: ${err.message}`);
        });
        
        page.on('pageerror', (err) => {
          logger.error(`Page error in browser context for ${url}: ${err.message}`);
        });
        
        // Configure console logging from the browser
        page.on('console', (msg) => {
          if (msg.type() === 'error') {
            logger.warn(`Browser console error for ${url}: ${msg.text()}`);
          }
        });
        
        // Navigate to the page with robust error handling
        logger.info(`Navigating to ${url}`);
        try {
          await page.goto(url, {
            waitUntil: 'domcontentloaded', // Less strict than networkidle2
            timeout: 60000 // 60 second timeout
          });
          
          // Wait for the page to be in a more loaded state
          await page.waitForFunction(
            () => document.readyState === 'complete' || document.readyState === 'interactive',
            { timeout: 10000 }
          ).catch(e => {
            logger.warn(`Page didn't reach 'complete' state for ${url}, continuing anyway: ${e.message}`);
          });
          
          // Wait a bit more for any JS to execute
          await page.waitForTimeout(3000);
          
          // Handle common popups and overlays
          await this.handleCommonPopups(page, domain);
          
          // Take screenshot
          const screenshotPath = path.join(screenshotsDir, `${itemId}_${Date.now()}.jpg`);
          await page.screenshot({ 
            path: screenshotPath, 
            type: 'jpeg', 
            quality: 80,
            fullPage: false,
            clip: {
              x: 0,
              y: 0,
              width: 1280,
              height: 800
            }
          });
          
          logger.info(`Screenshot saved to ${screenshotPath}`);
          
          // Close the page to free resources
          await page.close().catch(e => logger.warn(`Error closing page: ${e.message}`));
          
          return screenshotPath;
        } catch (navError) {
          // If navigation times out or fails, we'll still try to take a screenshot
          logger.warn(`Navigation error for ${url}: ${navError.message}`);
          
          if (navError.message.includes('net::ERR_ABORTED') || 
              navError.message.includes('Navigation timeout')) {
            // Take a screenshot anyway, maybe we got enough of the page
            logger.info(`Attempting to take screenshot despite navigation error`);
            try {
              const screenshotPath = path.join(screenshotsDir, `${itemId}_${Date.now()}.jpg`);
              await page.screenshot({ 
                path: screenshotPath, 
                type: 'jpeg', 
                quality: 80,
                fullPage: false,
                clip: {
                  x: 0,
                  y: 0,
                  width: 1280,
                  height: 800
                }
              });
              
              logger.info(`Partial screenshot saved to ${screenshotPath}`);
              await page.close().catch(() => {});
              return screenshotPath;
            } catch (ssError) {
              logger.error(`Failed to take partial screenshot: ${ssError.message}`);
              throw navError; // Re-throw the original error for retry handling
            }
          } else {
            throw navError; // Re-throw for retry handling
          }
        }
      } catch (pageError) {
        logger.error(`Error with page for ${url}: ${pageError.message}`);
        // Make sure we close the page to avoid memory leaks
        if (page) {
          await page.close().catch(() => {});
        }
        throw pageError; // Re-throw for retry handling
      }
    } catch (error) {
      logger.error(`Error taking screenshot of ${url} (attempt ${retries + 1}/${maxRetries + 1}): ${error.message}`);
      
      retries++;
      
      if (retries > maxRetries) {
        logger.error(`Failed to take screenshot of ${url} after ${maxRetries + 1} attempts`);
        return null;
      }
      
      // If there was an error, wait a bit before retrying
      const backoffTime = 5000 * retries; // Increasing backoff time
      logger.info(`Waiting ${backoffTime / 1000} seconds before retry ${retries}/${maxRetries}`);
      await new Promise(resolve => setTimeout(resolve, backoffTime));
      
      // If browser crashed during screenshot, reinitialize
      if (!this.browser) {
        logger.info('Browser appears to be disconnected, reinitializing before retry...');
        
        try {
          await this.initialize();
        } catch (initError) {
          logger.error(`Failed to reinitialize browser: ${initError.message}`);
          return null;
        }
      }
    }
  }
  
  // This should not be reached due to the return in the final retry, but just in case
  return null;
}

  /**
   * Clean up screenshots directory
   */
  async cleanupScreenshots() {
    try {
      logger.info('Cleaning up screenshots directory');
      const files = await fs.promises.readdir(screenshotsDir);
      
      for (const file of files) {
        const filePath = path.join(screenshotsDir, file);
        await fs.promises.unlink(filePath);
      }
      
      logger.info('Screenshots directory cleaned up');
    } catch (error) {
      logger.error(`Error cleaning up screenshots: ${error.message}`);
    }
  }
}

export default new ScraperService();