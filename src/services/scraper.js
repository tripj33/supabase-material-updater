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
        headless: false, // Set to false to make the browser visible
        args: ['--no-sandbox', '--disable-setuid-sandbox']
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
    if (!this.browser) {
      await this.initialize();
    }

    // If we already have a page for this domain, return it
    if (this.pages[domain]) {
      return this.pages[domain];
    }
    
    // Check how many pages are currently open
    const openDomains = Object.keys(this.pages);
    
    // If we have 2 or more pages open, close the oldest one that's not the current domain
    if (openDomains.length >= 2) {
      logger.info(`Limiting to 2 open tabs. Closing oldest tab for resource efficiency.`);
      const oldestDomain = openDomains[0]; // First domain is the oldest
      
      // Close the page
      try {
        await this.pages[oldestDomain].close();
        logger.info(`Closed page for domain: ${oldestDomain}`);
      } catch (error) {
        logger.warn(`Error closing page for domain ${oldestDomain}: ${error.message}`);
      }
      
      // Remove from pages object
      delete this.pages[oldestDomain];
    }
    
    // Create a new page for this domain
    logger.info(`Creating new page for domain: ${domain}`);
    this.pages[domain] = await this.browser.newPage();
    
    // Set viewport size
    await this.pages[domain].setViewport({ width: 1280, height: 800 });
    
    // Set user agent
    await this.pages[domain].setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
    );
    
    return this.pages[domain];
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
   * Take a screenshot of a product page
   * @param {string} url - The URL of the product page
   * @param {string} itemId - The ID of the item (for filename)
   * @returns {Promise<string|null>} Path to the screenshot or null if failed
   */
  async takeScreenshot(url, itemId) {
    try {
      const domain = this.extractDomain(url);
      logger.info(`Taking screenshot of ${url}`);
      
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
      
      // Get page for this domain
      const page = await this.getPage(domain);
      
      // Navigate to URL with extended timeout
      try {
        await page.goto(url, {
          waitUntil: 'networkidle2',
          timeout: 90000 // Increased to 90 seconds
        });
      } catch (timeoutError) {
        // If we're close to timeout, take a screenshot anyway and continue
        if (timeoutError.message.includes('timeout')) {
          logger.warn(`Page load timeout for ${url}, taking screenshot anyway`);
        } else {
          throw timeoutError;
        }
      }
      
      // Wait a bit for any dynamic content to load
      await page.waitForTimeout(2000);
      
      // Handle common popups and overlays
      await this.handleCommonPopups(page, domain);
      
      // Wait a bit more after handling popups
      await page.waitForTimeout(1000);
      
      // Take screenshot
      const screenshotPath = path.join(screenshotsDir, `${itemId}_${Date.now()}.jpg`);
      await page.screenshot({ path: screenshotPath, type: 'jpeg', quality: 80 });
      
      logger.info(`Screenshot saved to ${screenshotPath}`);
      return screenshotPath;
    } catch (error) {
      logger.error(`Error taking screenshot of ${url}: ${error.message}`);
      return null;
    }
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
