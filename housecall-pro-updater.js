import dotenv from 'dotenv';
import { logger } from './src/utils/logger.js';
import housecallProService from './src/services/housecall-pro.js';
import databaseService from './src/services/database.js';

// Load environment variables
dotenv.config();

// Parse command line arguments
const args = process.argv.slice(2);
const options = {
  limit: null,
  dryRun: false,
  categoryUuid: null
};

// Process command line arguments
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  
  if (arg === '--limit' && i + 1 < args.length) {
    options.limit = parseInt(args[i + 1], 10);
    i++;
  } else if (arg === '--dry-run') {
    options.dryRun = true;
  } else if (arg === '--category' && i + 1 < args.length) {
    options.categoryUuid = args[i + 1];
    i++;
  }
}

// Log options
if (options.limit) {
  logger.info(`Limiting to ${options.limit} categories for testing`);
}
if (options.dryRun) {
  logger.info('Running in dry-run mode - no actual updates will be made');
}
if (options.categoryUuid) {
  logger.info(`Processing only category with UUID: ${options.categoryUuid}`);
}

/**
 * Update Housecall Pro materials with prices from Supabase database
 */
class HousecallProUpdater {
  constructor() {
    this.updatedCount = 0;
    this.skippedCount = 0;
    this.errorCount = 0;
    this.updatedMaterials = [];
    this.errorMaterials = [];
  }

  /**
   * Convert price from dollars to cents
   * @param {number} price - Price in dollars
   * @returns {number} Price in cents
   */
  convertToCents(price) {
    return Math.round(price * 100);
  }

  /**
   * Find material item in Supabase by SKU
   * @param {string} sku - SKU/part number to search for
   * @returns {Promise<Object|null>} Material item or null if not found
   */
  async findMaterialItemBySku(sku) {
    try {
      if (!sku) {
        return null;
      }
      
      logger.info(`Searching for material item with SKU: ${sku}`);
      
      const materialItems = await databaseService.searchMaterialItemsBySku(sku);
      
      if (materialItems.length === 0) {
        logger.warn(`No material item found with SKU: ${sku}`);
        return null;
      }
      
      logger.info(`Found material item with SKU ${sku}: ${materialItems[0].name}`);
      return materialItems[0];
    } catch (error) {
      logger.error(`Error finding material item with SKU ${sku}: ${error.message}`);
      return null;
    }
  }

  /**
   * Update a single Housecall Pro material
   * @param {Object} material - Housecall Pro material
   * @returns {Promise<boolean>} Success status
   */
  async updateSingleMaterial(material) {
    try {
      const { uuid, part_number, name, image } = material;
      
      // Skip materials without part numbers
      if (!part_number) {
        logger.warn(`Skipping material ${uuid} (${name}) - no part number`);
        this.skippedCount++;
        return false;
      }
      
      // Find matching material item in Supabase
      const materialItem = await this.findMaterialItemBySku(part_number);
      
      // Skip if no matching material found
      if (!materialItem) {
        logger.warn(`Skipping material ${uuid} (${name}) - no matching material item found in Supabase`);
        this.skippedCount++;
        return false;
      }
      
      // Skip if material item has no sale price
      if (!materialItem.sale_price) {
        logger.warn(`Skipping material ${uuid} (${name}) - no sale price in Supabase`);
        this.skippedCount++;
        return false;
      }
      
      // Convert price from dollars to cents
      const priceCents = this.convertToCents(materialItem.sale_price);
      
      // Prepare update data
      const updateData = {
        cost: priceCents
      };
      
      // Add image URL if material has no image and Supabase item has an image URL
      if (!image && materialItem.image_url) {
        updateData.image = materialItem.image_url;
      }
      
      // If in dry-run mode, don't actually update
      if (options.dryRun) {
        logger.info(`[DRY RUN] Would update material ${uuid} (${name}) with cost: $${materialItem.sale_price} (${priceCents} cents)`);
      } else {
        // Update material in Housecall Pro
        await housecallProService.updateMaterial(uuid, updateData);
        logger.info(`Updated material ${uuid} (${name}) with cost: $${materialItem.sale_price} (${priceCents} cents)`);
      }
      
      // Track updated material
      this.updatedCount++;
      this.updatedMaterials.push({
        uuid,
        name,
        part_number,
        old_price: material.price,
        new_price: priceCents,
        image_updated: !image && !!materialItem.image_url,
        dry_run: options.dryRun
      });
      
      return true;
    } catch (error) {
      logger.error(`Error updating material ${material.uuid} (${material.name}): ${error.message}`);
      
      // Track error
      this.errorCount++;
      this.errorMaterials.push({
        uuid: material.uuid,
        name: material.name,
        part_number: material.part_number,
        error: error.message
      });
      
      return false;
    }
  }

  /**
   * Process materials for a category
   * @param {string} categoryUuid - Category UUID
   * @param {string} categoryName - Category name
   * @returns {Promise<number>} Number of updated materials
   */
  async processCategoryMaterials(categoryUuid, categoryName) {
    try {
      logger.info(`Processing materials for category: ${categoryName} (${categoryUuid})`);
      
      // Get materials for this category
      const materials = await housecallProService.getMaterialsByCategory(categoryUuid);
      
      logger.info(`Found ${materials.length} materials in category ${categoryName}`);
      
      // Process each material
      let updatedInCategory = 0;
      
      for (const material of materials) {
        const success = await this.updateSingleMaterial(material);
        
        if (success) {
          updatedInCategory++;
        }
      }
      
      logger.info(`Updated ${updatedInCategory} materials in category ${categoryName}`);
      return updatedInCategory;
    } catch (error) {
      logger.error(`Error processing materials for category ${categoryName}: ${error.message}`);
      return 0;
    }
  }

  /**
   * Process all categories and their materials
   * @returns {Promise<void>}
   */
  async processAllCategories() {
    try {
      logger.info('Starting to process all Housecall Pro material categories');
      
      // Get all material categories
      const categories = await housecallProService.getMaterialCategories();
      
      logger.info(`Found ${categories.length} material categories in Housecall Pro`);
      
      // Filter categories if a specific category UUID is provided
      let categoriesToProcess = categories;
      if (options.categoryUuid) {
        categoriesToProcess = categories.filter(category => category.uuid === options.categoryUuid);
        
        if (categoriesToProcess.length === 0) {
          logger.error(`No category found with UUID: ${options.categoryUuid}`);
          return;
        }
      }
      
      // Apply limit if specified
      if (options.limit && options.limit > 0) {
        categoriesToProcess = categoriesToProcess.slice(0, options.limit);
        logger.info(`Processing ${categoriesToProcess.length} categories due to --limit option`);
      }
      
      // Process each category
      for (const category of categoriesToProcess) {
        await this.processCategoryMaterials(category.uuid, category.name);
      }
      
      logger.info('Finished processing Housecall Pro material categories');
    } catch (error) {
      logger.error(`Error processing categories: ${error.message}`);
    }
  }

  /**
   * Run the updater
   * @returns {Promise<void>}
   */
  async run() {
    try {
      logger.info('Starting Housecall Pro material updater');
      
      // Reset counters
      this.updatedCount = 0;
      this.skippedCount = 0;
      this.errorCount = 0;
      this.updatedMaterials = [];
      this.errorMaterials = [];
      
      // Process all categories
      await this.processAllCategories();
      
      // Log summary
      logger.info('Housecall Pro material updater completed');
      logger.info(`Results: ${this.updatedCount} updated, ${this.skippedCount} skipped, ${this.errorCount} errors`);
      
      // Log details of updated materials
      if (this.updatedMaterials.length > 0) {
        logger.info('Updated materials:');
        for (const material of this.updatedMaterials) {
          logger.info(`- ${material.name} (${material.part_number}): ${material.old_price / 100} -> ${material.new_price / 100} ${material.image_updated ? '(image updated)' : ''}`);
        }
      }
      
      // Log details of errors
      if (this.errorMaterials.length > 0) {
        logger.error('Errors:');
        for (const material of this.errorMaterials) {
          logger.error(`- ${material.name} (${material.part_number}): ${material.error}`);
        }
      }
    } catch (error) {
      logger.error(`Error running Housecall Pro updater: ${error.message}`);
    }
  }
}

// Create and run the updater
const updater = new HousecallProUpdater();

// Run the updater
updater.run().catch(error => {
  logger.error(`Unhandled error: ${error.message}`);
  process.exit(1);
});
