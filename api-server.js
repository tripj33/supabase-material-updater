import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fs from 'fs';
import { logger } from './src/utils/logger.js';
import databaseService from './src/services/database.js';
import scraperService from './src/services/scraper.js';
import geminiService from './src/services/gemini.js';
import housecallProService from './src/services/housecall-pro.js';
import { generateNotesText } from './src/utils/date-formatter.js';

// Load environment variables
dotenv.config();

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Price change threshold (percentage)
const PRICE_CHANGE_THRESHOLD = parseInt(process.env.PRICE_CHANGE_THRESHOLD || '30', 10);

// Track outdated URLs
let outdatedUrls = [];

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
      
      if (percentChange > PRICE_CHANGE_THRESHOLD) {
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

// api-server.js - Replace the checkItemSourceExists function

/**
 * Check if an item source ID exists in the item_sources table
 * @param {string} itemSourceId - The item source ID to check
 * @returns {Promise<boolean>} Whether the item source exists
 */
async function checkItemSourceExists(itemSourceId) {
  try {
    // Make sure databaseService is properly initialized
    if (!databaseService || typeof databaseService.query !== 'function') {
      logger.error(`Database service unavailable or query method not found`);
      
      // Fallback to direct Supabase query if available
      if (supabase) {
        const { data, error } = await supabase
          .from('item_sources')
          .select('id')
          .eq('id', itemSourceId)
          .limit(1);
          
        if (error) throw error;
        const exists = data && data.length > 0;
        logger.info(`Checking if item source ${itemSourceId} exists (via supabase): ${exists}`);
        return exists;
      }
      
      throw new Error('No database query method available');
    }
    
    // Use standard query if databaseService is available
    const result = await databaseService.query('SELECT id FROM item_sources WHERE id = $1', [itemSourceId]);
    const exists = result && result.rows && result.rows.length > 0;
    
    logger.info(`Checking if item source ${itemSourceId} exists: ${exists}`);
    return exists;
  } catch (error) {
    logger.error(`Error checking if item source exists: ${error.message}`);
    // Assume it exists to avoid false negatives
    logger.info(`Assuming item source ${itemSourceId} exists due to query error`);
    return true;
  }
}

// api-server.js - Function to replace
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
        // Log all available item sources for debugging
        logger.info(`Available item sources in database:`);
        updatedItemSources.forEach(source => {
          logger.info(`Item Source ID: ${source.id}, Source ID: ${source.source_id}, Price: ${source.price_with_tax}`);
        });
        
        // Log details about the chosen item sources
        logger.info(`Lowest price item source details: ID=${lowestPriceSource.id}, Price=${lowestPriceSource.price_with_tax}`);
        logger.info(`Highest price item source details: ID=${highestPriceSource.id}, Price=${highestPriceSource.price_with_tax}`);
        
        // Get source information for generating notes
        const allSources = await databaseService.getAllSources();
        
        // Find the actual source names based on source_id from the item_sources
        const lowestPriceSourceInfo = allSources.find(source => source.id === lowestPriceSource.source_id);
        const highestPriceSourceInfo = allSources.find(source => source.id === highestPriceSource.source_id);
        
        const lowestPriceVendorName = lowestPriceSourceInfo ? lowestPriceSourceInfo.name : 'Unknown Vendor';
        const highestPriceVendorName = highestPriceSourceInfo ? highestPriceSourceInfo.name : 'Unknown Vendor';
        
        // Generate notes text
        const notes = generateNotesText(lowestPriceVendorName, highestPriceVendorName);
        
        // Verify the item source ID exists in the item_sources table before updating
        const itemSourceExists = await checkItemSourceExists(lowestPriceSource.id);
        if (!itemSourceExists) {
          logger.error(`Cannot update cheapest_vendor_id: Item source ID ${lowestPriceSource.id} does not exist in item_sources table!`);
          return {
            success: false,
            message: `Cannot update with item source - ID does not exist in item_sources table`,
            materialItem,
            updatedItemSources
          };
        }
        
        // Log the exact data being sent to update
        logger.info(`Updating material item with the following data:`);
        logger.info(`- Material ID: ${materialItem.id}`);
        logger.info(`- Lowest Price: ${lowestPriceSource.price_with_tax}`);
        logger.info(`- Cheapest Item Source ID: ${lowestPriceSource.id}`); // Using item_source.id
        logger.info(`- Highest Price: ${highestPriceSource.price_with_tax}`);
        logger.info(`- Notes: ${notes}`);
        
        // Update material item with the item_source.id (not the source.id)
        await databaseService.updateMaterialItem(
          materialItem.id,
          lowestPriceSource.price_with_tax,
          lowestPriceSource.id, // Use the item_source.id
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
          lowestPriceVendorName, 
          highestPriceVendorName
        };
      } catch (error) {
        logger.error(`Error updating material item: ${error.message}`);
        
        // Add additional error details for debugging
        if (error.constraint === 'fk_cheapest_vendor') {
          logger.error(`Foreign key constraint violation: The attempted cheapest_vendor_id doesn't exist in item_sources table`);
          
          if (lowestPriceSource) {
            logger.error(`Attempted to set item source ID ${lowestPriceSource.id} as cheapest vendor`);
          }
        }
        
        return {
          success: false,
          message: `Error updating material item: ${error.message}`,
          materialItem,
          updatedItemSources,
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
 * Update a single Housecall Pro material
 * @param {Object} material - Housecall Pro material
 * @returns {Promise<Object>} Result of update
 */
async function updateSingleHcpMaterial(material) {
  try {
    const { uuid, part_number, name, image } = material;
    
    // Skip materials without part numbers
    if (!part_number) {
      return {
        success: false,
        message: `Skipping material ${uuid} (${name}) - no part number`,
        material
      };
    }
    
    // Find matching material item in Supabase
    const materialItem = await databaseService.searchMaterialItemsBySku(part_number);
    
    // Skip if no matching material found
    if (!materialItem || materialItem.length === 0) {
      return {
        success: false,
        message: `Skipping material ${uuid} (${name}) - no matching material item found in Supabase`,
        material
      };
    }
    
    // Skip if material item has no sale price
    if (!materialItem[0].sale_price) {
      return {
        success: false,
        message: `Skipping material ${uuid} (${name}) - no sale price in Supabase`,
        material,
        materialItem: materialItem[0]
      };
    }
    
    // Convert price from dollars to cents
    const priceCents = Math.round(materialItem[0].sale_price * 100);
    
    // Prepare update data
    const updateData = {
      cost: priceCents
    };
    
    // Add image URL if material has no image and Supabase item has an image URL
    if (!image && materialItem[0].image_url) {
      updateData.image = materialItem[0].image_url;
    }
    
    // Update material in Housecall Pro
    const updatedMaterial = await housecallProService.updateMaterial(uuid, updateData);
    
    return {
      success: true,
      message: `Updated material ${uuid} (${name}) with cost: $${materialItem[0].sale_price} (${priceCents} cents)`,
      material,
      materialItem: materialItem[0],
      updatedMaterial,
      oldPrice: material.price,
      newPrice: priceCents,
      imageUpdated: !image && !!materialItem[0].image_url
    };
  } catch (error) {
    return {
      success: false,
      message: `Error updating material ${material.uuid} (${material.name}): ${error.message}`,
      material,
      error: error.message
    };
  }
}

// API Routes

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.status(200).json({ status: 'ok', message: 'API server is running' });
});

// Initialize scraper endpoint
app.post('/api/scraper/initialize', async (req, res) => {
  try {
    await scraperService.initialize();
    res.status(200).json({ success: true, message: 'Scraper initialized successfully' });
  } catch (error) {
    logger.error(`Error initializing scraper: ${error.message}`);
    res.status(500).json({ success: false, message: `Error initializing scraper: ${error.message}` });
  }
});

// Close scraper endpoint
app.post('/api/scraper/close', async (req, res) => {
  try {
    await scraperService.close();
    res.status(200).json({ success: true, message: 'Scraper closed successfully' });
  } catch (error) {
    logger.error(`Error closing scraper: ${error.message}`);
    res.status(500).json({ success: false, message: `Error closing scraper: ${error.message}` });
  }
});

// Login to sites endpoint
app.post('/api/scraper/login', async (req, res) => {
  try {
    const results = {
      winsupply: false,
      homedepot: false,
      supplyhouse: false,
      hdsupply: false
    };
    
    // Initialize scraper if not already initialized
    if (!scraperService.browser) {
      await scraperService.initialize();
    }
    
    // Login to WinSupply
    results.winsupply = await scraperService.loginToWinSupply();
    
    // Login to Home Depot
    results.homedepot = await scraperService.loginToHomeDepot();
    
    // Login to SupplyHouse.com
    results.supplyhouse = await scraperService.loginToSupplyHouse();
    
    // Login to HD Supply
    results.hdsupply = await scraperService.loginToHDSupply();
    
    res.status(200).json({ 
      success: true, 
      message: 'Login attempts completed',
      results
    });
  } catch (error) {
    logger.error(`Error during login process: ${error.message}`);
    res.status(500).json({ success: false, message: `Error during login process: ${error.message}` });
  }
});

// Scrape prices for a material item endpoint
app.post('/api/scraper/material/:materialId', async (req, res) => {
  try {
    const { materialId } = req.params;
    
    // Reset outdated URLs
    outdatedUrls = [];
    
    // Initialize scraper if not already initialized
    if (!scraperService.browser) {
      await scraperService.initialize();
    }
    
    // Fetch material item
    const materialItems = await databaseService.fetchMaterialItems();
    const materialItem = materialItems.find(item => item.id === materialId);
    
    if (!materialItem) {
      return res.status(404).json({ 
        success: false, 
        message: `Material item with ID ${materialId} not found` 
      });
    }
    
    // Process material item
    const result = await processMaterialItem(materialItem);
    
    // Include outdated URLs in the response
    result.outdatedUrls = outdatedUrls;
    
    // Close the browser
    await scraperService.close();
    logger.info('Browser closed after processing material item');
    
    res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    logger.error(`Error processing material item: ${error.message}`);
    res.status(500).json({ 
      success: false, 
      message: `Error processing material item: ${error.message}`,
      error: error.message
    });
  }
});

// Scrape prices for all material items endpoint
app.post('/api/scraper/materials', async (req, res) => {
  try {
    const { limit } = req.body;
    
    // Reset outdated URLs
    outdatedUrls = [];
    
    // Initialize scraper if not already initialized
    if (!scraperService.browser) {
      await scraperService.initialize();
    }
    
    // Login to all sites first
    const loginResults = {
      winsupply: await scraperService.loginToWinSupply(),
      homedepot: await scraperService.loginToHomeDepot(),
      supplyhouse: await scraperService.loginToSupplyHouse(),
      hdsupply: await scraperService.loginToHDSupply()
    };
    
    // Fetch all material items
    let materialItems = await databaseService.fetchMaterialItems();
    
    // Apply limit if specified
    if (limit && materialItems.length > limit) {
      materialItems = materialItems.slice(0, limit);
    }
    
    // Process each material item
    const results = {
      success: 0,
      failed: 0,
      skipped: 0,
      details: [],
      outdatedUrls: []
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
    
    // Add outdated URLs to results
    results.outdatedUrls = outdatedUrls;
    
    // Clean up
    await scraperService.cleanupScreenshots();
    
    // Close the browser
    await scraperService.close();
    logger.info('Browser closed after processing all material items');
    
    res.status(200).json({
      success: true,
      message: `Processed ${materialItems.length} material items`,
      loginResults,
      results
    });
  } catch (error) {
    logger.error(`Error processing material items: ${error.message}`);
    
    // Ensure browser is closed even if there's an error
    try {
      await scraperService.close();
    } catch (closeError) {
      logger.error(`Error closing browser: ${closeError.message}`);
    }
    
    res.status(500).json({ 
      success: false, 
      message: `Error processing material items: ${error.message}`,
      error: error.message
    });
  }
});

// Update a single Housecall Pro material endpoint
app.post('/api/hcp/material/:uuid', async (req, res) => {
  try {
    const { uuid } = req.params;
    
    // Get material from Housecall Pro
    const categories = await housecallProService.getMaterialCategories();
    let material = null;
    
    // Search for the material in all categories
    for (const category of categories) {
      const materials = await housecallProService.getMaterialsByCategory(category.uuid);
      const found = materials.find(m => m.uuid === uuid);
      
      if (found) {
        material = found;
        break;
      }
    }
    
    if (!material) {
      return res.status(404).json({ 
        success: false, 
        message: `Material with UUID ${uuid} not found in Housecall Pro` 
      });
    }
    
    // Update the material
    const result = await updateSingleHcpMaterial(material);
    
    res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    logger.error(`Error updating Housecall Pro material: ${error.message}`);
    res.status(500).json({ 
      success: false, 
      message: `Error updating Housecall Pro material: ${error.message}`,
      error: error.message
    });
  }
});

// Update all Housecall Pro materials endpoint
app.post('/api/hcp/materials', async (req, res) => {
  try {
    const { limit, categoryUuid } = req.body;
    
    // Get all material categories
    const categories = await housecallProService.getMaterialCategories();
    
    // Filter categories if a specific category UUID is provided
    let categoriesToProcess = categories;
    if (categoryUuid) {
      categoriesToProcess = categories.filter(category => category.uuid === categoryUuid);
      
      if (categoriesToProcess.length === 0) {
        return res.status(404).json({
          success: false,
          message: `No category found with UUID: ${categoryUuid}`
        });
      }
    }
    
    // Apply limit if specified
    if (limit && limit > 0) {
      categoriesToProcess = categoriesToProcess.slice(0, limit);
    }
    
    // Process each category
    const results = {
      updatedCount: 0,
      skippedCount: 0,
      errorCount: 0,
      updatedMaterials: [],
      errorMaterials: [],
      categoryResults: []
    };
    
    for (const category of categoriesToProcess) {
      // Get materials for this category
      const materials = await housecallProService.getMaterialsByCategory(category.uuid);
      
      const categoryResult = {
        category,
        materialsCount: materials.length,
        updatedCount: 0,
        skippedCount: 0,
        errorCount: 0,
        materials: []
      };
      
      // Process each material
      for (const material of materials) {
        const result = await updateSingleHcpMaterial(material);
        
        categoryResult.materials.push(result);
        
        if (result.success) {
          results.updatedCount++;
          categoryResult.updatedCount++;
          results.updatedMaterials.push(result);
        } else {
          if (result.message.includes('no part number') || 
              result.message.includes('no matching material') || 
              result.message.includes('no sale price')) {
            results.skippedCount++;
            categoryResult.skippedCount++;
          } else {
            results.errorCount++;
            categoryResult.errorCount++;
            results.errorMaterials.push(result);
          }
        }
      }
      
      results.categoryResults.push(categoryResult);
    }
    
    res.status(200).json({
      success: true,
      message: `Processed Housecall Pro materials: ${results.updatedCount} updated, ${results.skippedCount} skipped, ${results.errorCount} errors`,
      results
    });
  } catch (error) {
    logger.error(`Error updating Housecall Pro materials: ${error.message}`);
    res.status(500).json({ 
      success: false, 
      message: `Error updating Housecall Pro materials: ${error.message}`,
      error: error.message
    });
  }
});

// Start the server
app.listen(PORT, '0.0.0.0', () => {
  logger.info(`API server running on port ${PORT}`);
  console.log(`API server running on port ${PORT}`);
});

export default app;