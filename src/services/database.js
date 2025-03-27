import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { logger } from '../utils/logger.js';

// Load environment variables
dotenv.config();

// Initialize Supabase client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  logger.error('Supabase URL or key is missing in environment variables');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

/**
 * Database service for interacting with Supabase
 */
class DatabaseService {
  constructor() {
    this.supabase = supabase;
  }

  /**
   * Fetch all material items from the database
   * @param {number} [limit] - Optional limit on number of items to fetch
   * @returns {Promise<Array>} Array of material items
   */
  async fetchMaterialItems(limit) {
    try {
      logger.info(`Using Supabase URL: ${supabaseUrl}`);
      
      // Test connection first
      const { data: testData, error: testError } = await supabase
        .from('material_items')
        .select('id')
        .limit(1);
      
      if (testError) {
        throw testError;
      }
      
      logger.info(`Database connection test successful. Found ${testData.length} material items`);
      
      // Fetch actual data
      let query = supabase
        .from('material_items')
        .select('*');
      
      if (limit) {
        query = query.limit(limit);
      }
      
      const { data, error } = await query;

      if (error) {
        throw error;
      }

      logger.info(`Fetched ${data.length} material items`);
      return data;
    } catch (error) {
      logger.error(`Error fetching material items: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get all item sources for a material item
   * @param {string} materialItemId - Material item ID
   * @returns {Promise<Array>} Array of item sources
   */
  async getItemSourcesForMaterialItem(materialItemId) {
    try {
      const { data, error } = await this.supabase
        .from('item_sources')
        .select('*')
        .eq('item_id', materialItemId);
      
      if (error) {
        throw new Error(`Error fetching item sources: ${error.message}`);
      }
      
      return data;
    } catch (error) {
      logger.error(`Database error: ${error.message}`);
      throw error;
    }
  }

  /**
   * Search material items by SKU
   * @param {string} sku - SKU to search for
   * @returns {Promise<Array>} Array of matching material items
   */
  async searchMaterialItemsBySku(sku) {
    try {
      logger.info(`Searching for material items with SKU: ${sku}`);
      
      const { data, error } = await this.supabase
        .from('material_items')
        .select('*')
        .eq('sku', sku);
      
      if (error) {
        throw new Error(`Error searching material items by SKU: ${error.message}`);
      }
      
      logger.info(`Found ${data.length} material items with SKU: ${sku}`);
      return data;
    } catch (error) {
      logger.error(`Database error: ${error.message}`);
      throw error;
    }
  }

  /**
   * Fetch item sources for a specific material item
   * @param {string} materialItemId - The ID of the material item
   * @returns {Promise<Array>} Array of item sources
   */
  async fetchItemSources(materialItemId) {
    try {
      logger.info(`Fetching item sources for material item ${materialItemId}`);
      const { data, error } = await supabase
        .from('item_sources')
        .select(`
          *,
          sources:source_id (
            id,
            name
          )
        `)
        .eq('item_id', materialItemId);

      if (error) {
        throw error;
      }

      logger.info(`Fetched ${data.length} item sources for material item ${materialItemId}`);
      return data;
    } catch (error) {
      logger.error(`Error fetching item sources: ${error.message}`);
      throw error;
    }
  }

  /**
   * Update an item source with new pricing information
   * @param {string} itemSourceId - The ID of the item source
   * @param {number} salePrice - The new sale price
   * @param {number} priceWithTax - The new price with tax
   * @returns {Promise<Object>} Updated item source
   */
  async updateItemSource(itemSourceId, salePrice, priceWithTax) {
    try {
      logger.info(`Updating item source ${itemSourceId} with new pricing`);
      const { data, error } = await supabase
        .from('item_sources')
        .update({
          sale_price: salePrice,
          price_with_tax: priceWithTax,
          updated_at: new Date().toISOString()
        })
        .eq('id', itemSourceId)
        .select();

      if (error) {
        throw error;
      }

      logger.info(`Updated item source ${itemSourceId}`);
      return data[0];
    } catch (error) {
      logger.error(`Error updating item source: ${error.message}`);
      throw error;
    }
  }

  /**
   * Mark an item source URL as out of date
   * @param {string} itemSourceId - The ID of the item source
   * @returns {Promise<Object>} Updated item source
   */
  async markUrlAsOutdated(itemSourceId) {
    try {
      logger.info(`Marking item source ${itemSourceId} URL as out of date`);
      const { data, error } = await supabase
        .from('item_sources')
        .update({
          out_of_date_url: true,
          updated_at: new Date().toISOString()
        })
        .eq('id', itemSourceId)
        .select();

      if (error) {
        throw error;
      }

      logger.info(`Marked item source ${itemSourceId} URL as out of date`);
      return data[0];
    } catch (error) {
      logger.error(`Error marking URL as outdated: ${error.message}`);
      throw error;
    }
  }

  /**
   * Update a material item with new pricing information
   * @param {string} materialItemId - The ID of the material item
   * @param {number} cost - The new cost
   * @param {string} cheapestVendorId - The ID of the cheapest vendor
   * @param {number} salePrice - The new sale price
   * @param {string} notes - The new notes
   * @returns {Promise<Object>} Updated material item
   */
  async updateMaterialItem(materialItemId, cost, cheapestVendorId, salePrice, notes) {
    try {
      logger.info(`Updating material item ${materialItemId} with new pricing`);
      const { data, error } = await supabase
        .from('material_items')
        .update({
          cost,
          cheapest_vendor_id: cheapestVendorId,
          sale_price: salePrice,
          notes,
          updated_at: new Date().toISOString()
        })
        .eq('id', materialItemId)
        .select();

      if (error) {
        throw error;
      }

      logger.info(`Updated material item ${materialItemId}`);
      return data[0];
    } catch (error) {
      logger.error(`Error updating material item: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get source information by ID
   * @param {string} sourceId - The ID of the source
   * @returns {Promise<Object>} Source information
   */
  async getSourceById(sourceId) {
    try {
      const { data, error } = await supabase
        .from('sources')
        .select('*')
        .eq('id', sourceId)
        .single();

      if (error) {
        if (error.code === 'PGRST116') {
          // No rows returned - source not found
          logger.warn(`Source with ID ${sourceId} not found`);
          return null;
        }
        throw error;
      }

      return data;
    } catch (error) {
      logger.error(`Error fetching source: ${error.message}`);
      throw error;
    }
  }

  /**
   * Check if a source exists
   * @param {string} sourceId - The ID of the source
   * @returns {Promise<boolean>} Whether the source exists
   */
  async sourceExists(sourceId) {
    try {
      const source = await this.getSourceById(sourceId);
      return source !== null;
    } catch (error) {
      logger.error(`Error checking if source exists: ${error.message}`);
      return false;
    }
  }

  /**
   * Get all sources
   * @returns {Promise<Array>} Array of sources
   */
  async getAllSources() {
    try {
      const { data, error } = await supabase
        .from('sources')
        .select('*');

      if (error) {
        throw error;
      }

      return data;
    } catch (error) {
      logger.error(`Error fetching all sources: ${error.message}`);
      throw error;
    }
  }
}

export default new DatabaseService();
