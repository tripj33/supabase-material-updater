import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { logger } from './src/utils/logger.js';
import databaseService from './src/services/database.js';
import scraperService from './src/services/scraper.js';
import geminiService from './src/services/gemini.js';
import { generateNotesText } from './src/utils/date-formatter.js';

// Add stealth plugin to puppeteer
puppeteer.use(StealthPlugin());

// Load environment variables
dotenv.config();

// Get the directory name
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const screenshotsDir = path.join(__dirname, 'screenshots');

// Ensure screenshots directory exists
if (!fs.existsSync(screenshotsDir)) {
  fs.mkdirSync(screenshotsDir, { recursive: true });
}

// Track outdated URLs
const outdatedUrls = [];

/**
 * Process a single item source
 * @param {Object} itemSource - The item source to process
 * @param {Object} materialItem - The material item
 * @returns {Promise<Object|null>} Updated item source or null if failed
 */
async function processItemSource(itemSource, materialItem) {
  try {
    logger.info(`Processing item source ${itemSource.id} for material item ${materialItem.id}`);
    
    // Take screenshot of the product page
    const screenshotPath = await scraperService.takeScreenshot(itemSource.url, itemSource.id);
    
    if (!screenshotPath) {
      logger.error(`Failed to take screenshot for item source ${itemSource.id}`);
      await databaseService.markUrlAsOutdated(itemSource.id);
      outdatedUrls.push({
        id: itemSource.id,
        url: itemSource.url,
        materialItemName: materialItem.name
      });
      return null;
    }
    
    // Extract price from screenshot
    const price = await geminiService.extractPriceFromImage(screenshotPath, materialItem.name);
    
    // Clean up screenshot
    try {
      await fs.promises.unlink(screenshotPath);
    } catch (error) {
      logger.warn(`Failed to delete screenshot ${screenshotPath}: ${error.message}`);
    }
    
    if (price === null) {
      logger.error(`Failed to extract price for item source ${itemSource.id}`);
      await databaseService.markUrlAsOutdated(itemSource.id);
      outdatedUrls.push({
        id: itemSource.id,
        url: itemSource.url,
        materialItemName: materialItem.name
      });
      return null;
    }
    
    // Calculate price with tax and round to two decimal places
    const roundedPrice = Math.round(price * 100) / 100;
    const priceWithTax = Math.round((roundedPrice * 1.15) * 100) / 100;
    
    // Check for significant price change
    if (itemSource.sale_price !== null) {
      const percentChange = Math.abs((price - itemSource.sale_price) / itemSource.sale_price * 100);
      
      if (percentChange > 30) {
        const vendorName = itemSource.sources ? itemSource.sources.name : 'Unknown Vendor';
        logger.info(
          `Significant price change detected for ${materialItem.name} from ${vendorName}: ` +
          `${itemSource.sale_price} -> ${price} (${percentChange.toFixed(2)}%)`
        );
      }
    }
    
    // Update item source with new pricing
    const updatedItemSource = await databaseService.updateItemSource(itemSource.id, price, priceWithTax);
    
    logger.info(`Updated item source ${itemSource.id} with price ${price} (${priceWithTax} with tax)`);
    return updatedItemSource;
  } catch (error) {
    logger.error(`Error processing item source ${itemSource.id}: ${error.message}`);
    return null;
  }
}

/**
 * Group item sources by domain
 * @param {Array} itemSources - Array of item sources
 * @returns {Object} Object with domains as keys and arrays of item sources as values
 */
function groupItemSourcesByDomain(itemSources) {
  const groups = {};
  
  for (const source of itemSources) {
    try {
      const url = new URL(source.url);
      const domain = url.hostname;
      
      if (!groups[domain]) {
        groups[domain] = [];
      }
      
      groups[domain].push(source);
    } catch (error) {
      logger.error(`Invalid URL for item source ${source.id}: ${source.url}`);
    }
  }
  
  return groups;
}

/**
 * Process all item sources for a material item
 * @param {Object} materialItem - The material item to process
 * @returns {Promise<Object>} Result of processing
 */
async function processMaterialItem(materialItem) {
  try {
    logger.info(`Processing material item ${materialItem.id}: ${materialItem.name}`);
    
    // Fetch item sources for this material item
    const itemSources = await databaseService.fetchItemSources(materialItem.id);
    
    if (itemSources.length === 0) {
      logger.warn(`No item sources found for material item ${materialItem.id}`);
      return {
        success: false,
        message: `No item sources found for material item ${materialItem.id}`,
        materialItem
      };
    }
    
    // Group item sources by domain
    const domainGroups = groupItemSourcesByDomain(itemSources);
    
    // Process each domain group
    const updatedItemSources = [];
    
    for (const [domain, sources] of Object.entries(domainGroups)) {
      logger.info(`Processing ${sources.length} item sources for domain ${domain}`);
      
      // Process each item source in this domain group
      for (const source of sources) {
        const updatedSource = await processItemSource(source, materialItem);
        
        if (updatedSource) {
          updatedItemSources.push(updatedSource);
        }
      }
    }
    
    // Find lowest and highest priced item sources
    let lowestPriceSource = null;
    let highestPriceSource = null;
    
    for (const source of updatedItemSources) {
      if (!lowestPriceSource || source.price_with_tax < lowestPriceSource.price_with_tax) {
        lowestPriceSource = source;
      }
      
      if (!highestPriceSource || source.price_with_tax > highestPriceSource.price_with_tax) {
        highestPriceSource = source;
      }
    }
    
    // Update material item if we have pricing information
    if (lowestPriceSource && highestPriceSource) {
      try {
        // Get all sources for debugging
        const allSources = await databaseService.getAllSources();
        
        // Check if these IDs exist in the sources table
        const lowestPriceSourceExists = allSources.some(source => source.id.startsWith(lowestPriceSource.source_id));
        const highestPriceSourceExists = allSources.some(source => source.id.startsWith(highestPriceSource.source_id));
        
        // Find the actual source IDs from the database
        const actualLowestSourceId = lowestPriceSourceExists 
          ? allSources.find(source => source.id.startsWith(lowestPriceSource.source_id))?.id
          : null;
        
        const actualHighestSourceId = highestPriceSourceExists
          ? allSources.find(source => source.id.startsWith(highestPriceSource.source_id))?.id
          : null;
        
        if (!lowestPriceSourceExists || !highestPriceSourceExists) {
          logger.error(`Source IDs do not exist in sources table`);
          
          // Find the first valid source ID to use as a fallback
          if (allSources.length > 0) {
            const fallbackSourceId = allSources[0].id;
            const fallbackSourceName = allSources[0].name;
            
            // Generate notes text
            const notes = generateNotesText(fallbackSourceName, fallbackSourceName);
            
            // Update material item with fallback source ID
            await databaseService.updateMaterialItem(
              materialItem.id,
              lowestPriceSource.price_with_tax,
              fallbackSourceId,
              highestPriceSource.price_with_tax,
              notes
            );
            
            logger.info(`Updated material item ${materialItem.id} with new pricing information (using fallback vendor ID)`);
            
            return {
              success: true,
              message: `Updated material item ${materialItem.id} with new pricing information (using fallback vendor ID)`,
              materialItem,
              updatedItemSources,
              lowestPriceSource,
              highestPriceSource,
              usedFallback: true
            };
          }
          
          logger.warn(`Skipping update for material item ${materialItem.id} due to missing source information`);
          
          return {
            success: false,
            message: `Skipping update for material item ${materialItem.id} due to missing source information`,
            materialItem,
            updatedItemSources
          };
        }
        
        try {
          // Get vendor names using the actual source IDs from the database
          const lowestPriceVendor = await databaseService.getSourceById(actualLowestSourceId);
          const highestPriceVendor = await databaseService.getSourceById(actualHighestSourceId);
          
          if (!lowestPriceVendor || !highestPriceVendor) {
            logger.error(`Could not get vendor information for source IDs: ${actualLowestSourceId}, ${actualHighestSourceId}`);
            
            return {
              success: false,
              message: `Could not get vendor information for source IDs: ${actualLowestSourceId}, ${actualHighestSourceId}`,
              materialItem,
              updatedItemSources
            };
          }
          
          // Generate notes text
          const notes = generateNotesText(lowestPriceVendor.name, highestPriceVendor.name);
          
          // Update material item
          await databaseService.updateMaterialItem(
            materialItem.id,
            lowestPriceSource.price_with_tax,
            actualLowestSourceId,
            highestPriceSource.price_with_tax,
            notes
          );
          
          logger.info(`Updated material item ${materialItem.id} with new pricing information`);
          
          return {
            success: true,
            message: `Updated material item ${materialItem.id} with new pricing information`,
            materialItem,
            updatedItemSources,
            lowestPriceSource,
            highestPriceSource,
            lowestPriceVendor,
            highestPriceVendor
          };
        } catch (error) {
          logger.error(`Error updating material item: ${error.message}`);
          
          return {
            success: false,
            message: `Error updating material item: ${error.message}`,
            materialItem,
            updatedItemSources,
            error: error.message
          };
        }
      } catch (error) {
        logger.error(`Error updating material item ${materialItem.id}: ${error.message}`);
        
        return {
          success: false,
          message: `Error updating material item ${materialItem.id}: ${error.message}`,
          materialItem,
          error: error.message
        };
      }
    } else {
      logger.warn(`Could not update material item ${materialItem.id} due to missing pricing information`);
      
      return {
        success: false,
        message: `Could not update material item ${materialItem.id} due to missing pricing information`,
        materialItem,
        updatedItemSources
      };
    }
  } catch (error) {
    logger.error(`Error processing material item ${materialItem.id}: ${error.message}`);
    
    return {
      success: false,
      message: `Error processing material item ${materialItem.id}: ${error.message}`,
      materialItem,
      error: error.message
    };
  }
}

/**
 * Main function to run the price scraper
 * @param {Object} options - Options for the scraper
 * @param {number} [options.limit] - Maximum number of material items to process
 * @param {string} [options.materialItemId] - Specific material item ID to process
 */
async function main(options = {}) {
  const { limit, materialItemId } = options;
  
  try {
    logger.info('Starting price scraper');
    
    // Initialize scraper
    await scraperService.initialize();
    
    // Login to all sites
    const loginResults = {
      winsupply: await scraperService.loginToWinSupply(),
      homedepot: await scraperService.loginToHomeDepot(),
      supplyhouse: await scraperService.loginToSupplyHouse(),
      hdsupply: await scraperService.loginToHDSupply()
    };
    
    logger.info('Login results:', loginResults);
    
    // Process material items
    let materialItems;
    
    if (materialItemId) {
      // Process a specific material item
      materialItems = await databaseService.fetchMaterialItems();
      materialItems = materialItems.filter(item => item.id === materialItemId);
      
      if (materialItems.length === 0) {
        logger.error(`Material item with ID ${materialItemId} not found`);
        await scraperService.close();
        return;
      }
    } else {
      // Process all material items (with optional limit)
      materialItems = await databaseService.fetchMaterialItems(limit);
    }
    
    logger.info(`Processing ${materialItems.length} material items`);
    
    // Process each material item
    const results = {
      success: 0,
      failed: 0,
      skipped: 0,
      details: []
    };
    
    for (const item of materialItems) {
      try {
        const result = await processMaterialItem(item);
        results.details.push(result);
        
        if (result.success) {
          results.success++;
        } else {
          results.failed++;
        }
      } catch (error) {
        logger.error(`Failed to process material item ${item.id}: ${error.message}`);
        results.failed++;
        results.details.push({
          success: false,
          message: `Failed to process material item ${item.id}: ${error.message}`,
          materialItem: item,
          error: error.message
        });
      }
    }
    
    // Log results
    logger.info(`Processed ${materialItems.length} material items:`);
    logger.info(`- Success: ${results.success}`);
    logger.info(`- Failed: ${results.failed}`);
    
    // Log outdated URLs
    if (outdatedUrls.length > 0) {
      logger.info(`Found ${outdatedUrls.length} outdated URLs:`);
      for (const item of outdatedUrls) {
        logger.info(`- ${item.materialItemName}: ${item.url} (ID: ${item.id})`);
      }
    }
    
    // Clean up
    await scraperService.cleanupScreenshots();
    await scraperService.close();
    
    logger.info('Price scraper completed');
  } catch (error) {
    logger.error(`Error running price scraper: ${error.message}`);
    
    // Ensure browser is closed even if there's an error
    try {
      await scraperService.close();
    } catch (closeError) {
      logger.error(`Error closing browser: ${closeError.message}`);
    }
  }
}

// Parse command line arguments
const args = process.argv.slice(2);
const options = {};

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--limit' && i + 1 < args.length) {
    options.limit = parseInt(args[i + 1], 10);
    i++;
  } else if (args[i] === '--material-item-id' && i + 1 < args.length) {
    options.materialItemId = args[i + 1];
    i++;
  }
}

// Run the main function
main(options);
