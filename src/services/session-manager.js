import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../utils/logger.js';

// Get the directory name
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSIONS_DIR = path.join(__dirname, '../../sessions');
const SESSION_VALIDITY_HOURS = 24; // Sessions valid for 24 hours

/**
 * Session Manager for handling persistent sessions
 */
class SessionManager {
  constructor() {
    this.sessions = {};
    this.initialized = false;
  }

  /**
   * Initialize the session manager
   * @returns {Promise<void>}
   */
  async initialize() {
    if (this.initialized) return;
    
    try {
      // Create sessions directory if it doesn't exist
      await fs.mkdir(SESSIONS_DIR, { recursive: true });
      
      // Load existing sessions
      const files = await fs.readdir(SESSIONS_DIR);
      
      for (const file of files) {
        if (file.endsWith('.json')) {
          try {
            const sessionData = JSON.parse(
              await fs.readFile(path.join(SESSIONS_DIR, file), 'utf-8')
            );
            
            const domain = file.replace('.json', '');
            
            // Check if session is still valid
            if (this.isSessionValid(sessionData)) {
              this.sessions[domain] = sessionData;
              logger.info(`Loaded valid session for domain: ${domain}`);
            } else {
              logger.info(`Found expired session for domain: ${domain}, will re-login`);
              // Remove expired session file
              await fs.unlink(path.join(SESSIONS_DIR, file));
            }
          } catch (error) {
            logger.warn(`Error loading session file ${file}: ${error.message}`);
          }
        }
      }
      
      this.initialized = true;
      logger.info(`Session manager initialized with ${Object.keys(this.sessions).length} valid sessions`);
    } catch (error) {
      logger.error(`Error initializing session manager: ${error.message}`);
      throw error;
    }
  }

  /**
   * Check if a session is still valid
   * @param {Object} sessionData - Session data object
   * @returns {boolean} Whether the session is valid
   */
  isSessionValid(sessionData) {
    if (!sessionData || !sessionData.timestamp) {
      return false;
    }
    
    const sessionTime = new Date(sessionData.timestamp);
    const now = new Date();
    const diffHours = (now - sessionTime) / (1000 * 60 * 60);
    
    return diffHours < SESSION_VALIDITY_HOURS;
  }

  /**
   * Save a session for a domain
   * @param {string} domain - Domain name
   * @param {Array} cookies - Array of cookies
   * @param {Object} extraData - Extra data to save with the session
   * @returns {Promise<boolean>} Success status
   */
  async saveSession(domain, cookies, extraData = {}) {
    if (!this.initialized) {
      await this.initialize();
    }
    
    try {
      const sessionData = {
        timestamp: new Date().toISOString(),
        cookies: cookies,
        ...extraData
      };
      
      this.sessions[domain] = sessionData;
      
      // Save to file
      await fs.writeFile(
        path.join(SESSIONS_DIR, `${domain}.json`),
        JSON.stringify(sessionData, null, 2),
        'utf-8'
      );
      
      logger.info(`Saved session for domain: ${domain}`);
      return true;
    } catch (error) {
      logger.error(`Error saving session for domain ${domain}: ${error.message}`);
      return false;
    }
  }

  /**
   * Get a session for a domain
   * @param {string} domain - Domain name
   * @returns {Promise<Object|null>} Session data or null if not found or expired
   */
  async getSession(domain) {
    if (!this.initialized) {
      await this.initialize();
    }
    
    const session = this.sessions[domain];
    
    if (!session) {
      return null;
    }
    
    if (!this.isSessionValid(session)) {
      logger.info(`Session for domain ${domain} has expired, removing it`);
      delete this.sessions[domain];
      
      try {
        await fs.unlink(path.join(SESSIONS_DIR, `${domain}.json`));
      } catch (error) {
        logger.warn(`Error removing expired session file: ${error.message}`);
      }
      
      return null;
    }
    
    return session;
  }

  /**
   * Clear a session for a domain
   * @param {string} domain - Domain name
   * @returns {Promise<boolean>} Success status
   */
  async clearSession(domain) {
    if (!this.initialized) {
      await this.initialize();
    }
    
    delete this.sessions[domain];
    
    try {
      const filePath = path.join(SESSIONS_DIR, `${domain}.json`);
      const exists = await fs.access(filePath).then(() => true).catch(() => false);
      
      if (exists) {
        await fs.unlink(filePath);
      }
      
      logger.info(`Cleared session for domain: ${domain}`);
      return true;
    } catch (error) {
      logger.warn(`Error clearing session for domain ${domain}: ${error.message}`);
      return false;
    }
  }

  /**
   * Clear all sessions
   * @returns {Promise<boolean>} Success status
   */
  async clearAllSessions() {
    if (!this.initialized) {
      await this.initialize();
    }
    
    this.sessions = {};
    
    try {
      const files = await fs.readdir(SESSIONS_DIR);
      
      for (const file of files) {
        if (file.endsWith('.json')) {
          await fs.unlink(path.join(SESSIONS_DIR, file));
        }
      }
      
      logger.info('Cleared all sessions');
      return true;
    } catch (error) {
      logger.error(`Error clearing all sessions: ${error.message}`);
      return false;
    }
  }
  
  /**
   * Apply session cookies to a page
   * @param {string} domain - Domain name
   * @param {Page} page - Puppeteer page
   * @returns {Promise<boolean>} Success status
   */
  async applySessionToPage(domain, page) {
    const session = await this.getSession(domain);
    
    if (!session || !session.cookies || !session.cookies.length) {
      return false;
    }
    
    try {
      await page.setCookie(...session.cookies);
      logger.info(`Applied session cookies to page for domain: ${domain}`);
      return true;
    } catch (error) {
      logger.error(`Error applying session cookies to page: ${error.message}`);
      return false;
    }
  }
  
  /**
   * Get status of session manager
   * @returns {Object} Status information
   */
  getStatus() {
    return {
      initialized: this.initialized,
      activeSessions: Object.keys(this.sessions).length,
      sessionDomains: Object.keys(this.sessions)
    };
  }
}

export default new SessionManager();