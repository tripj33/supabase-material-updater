import { logger } from '../utils/logger.js';

/**
 * Mock database service for testing
 */
class MockDatabaseService {
  constructor() {
    // Create mock data
    this.materialItems = [
      {
        id: '1',
        name: 'Test Material 1',
        cost: 100,
        sale_price: 150,
        cheapest_vendor_id: '1',
        notes: 'Test notes'
      },
      {
        id: '2',
        name: 'Test Material 2',
        cost: 200,
        sale_price: 250,
        cheapest_vendor_id: '2',
        notes: 'Test notes'
      }
    ];
    
    this.itemSources = {
      '1': [
        {
          id: '1',
          item_id: '1',
          source_id: '1',
          url: 'https://www.homedepot.com/p/Milwaukee-M18-18-Volt-Lithium-Ion-Cordless-Combo-Tool-Kit-5-Tool-with-Two-3-0-Ah-Batteries-Charger-Tool-Bag-2695-25CX/305663412',
          sale_price: 100,
          price_with_tax: 115,
          out_of_date_url: false,
          sources: {
            id: '1',
            name: 'Home Depot'
          }
        },
        {
          id: '2',
          item_id: '1',
          source_id: '2',
          url: 'https://www.amazon.com/Milwaukee-2695-25CX-M18-Combo-Kit/dp/B07CMHVPV1',
          sale_price: 110,
          price_with_tax: 126.5,
          out_of_date_url: false,
          sources: {
            id: '2',
            name: 'Amazon'
          }
        }
      ],
      '2': [
        {
          id: '3',
          item_id: '2',
          source_id: '1',
          url: 'https://www.homedepot.com/p/Milwaukee-M18-FUEL-18-Volt-Lithium-Ion-Brushless-Cordless-Hammer-Drill-and-Impact-Driver-Combo-Kit-2-Tool-with-2-Batteries-2997-22/305063033',
          sale_price: 200,
          price_with_tax: 230,
          out_of_date_url: false,
          sources: {
            id: '1',
            name: 'Home Depot'
          }
        },
        {
          id: '4',
          item_id: '2',
          source_id: '3',
          url: 'https://www.winsupplyinc.com/milwaukee-2997-22-m18-fuel-2-tool-combo-kit-hammer-drill-impact-driver',
          sale_price: 190,
          price_with_tax: 218.5,
          out_of_date_url: false,
          sources: {
            id: '3',
            name: 'WinSupply'
          }
        }
      ]
    };
    
    this.sources = {
      '1': {
        id: '1',
        name: 'Home Depot'
      },
      '2': {
        id: '2',
        name: 'Amazon'
      },
      '3': {
        id: '3',
        name: 'WinSupply'
      }
    };
    
    // Track updates
    this.updates = {
      itemSources: {},
      materialItems: {}
    };
  }

  /**
   * Fetch all material items from the database
   * @returns {Promise<Array>} Array of material items
   */
  async fetchMaterialItems() {
    try {
      logger.info('Fetching material items from mock database');
      logger.info(`Found ${this.materialItems.length} material items`);
      return [...this.materialItems];
    } catch (error) {
      logger.error(`Error fetching material items: ${error.message}`);
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
      const sources = this.itemSources[materialItemId] || [];
      logger.info(`Fetched ${sources.length} item sources for material item ${materialItemId}`);
      return [...sources];
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
      
      // Find the item source
      let updatedSource = null;
      
      for (const materialItemId in this.itemSources) {
        const sources = this.itemSources[materialItemId];
        const sourceIndex = sources.findIndex(s => s.id === itemSourceId);
        
        if (sourceIndex !== -1) {
          // Update the item source
          updatedSource = {
            ...sources[sourceIndex],
            sale_price: salePrice,
            price_with_tax: priceWithTax,
            updated_at: new Date().toISOString()
          };
          
          // Store the update
          this.updates.itemSources[itemSourceId] = updatedSource;
          
          logger.info(`Updated item source ${itemSourceId}`);
          break;
        }
      }
      
      if (!updatedSource) {
        throw new Error(`Item source ${itemSourceId} not found`);
      }
      
      return updatedSource;
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
      
      // Find the item source
      let updatedSource = null;
      
      for (const materialItemId in this.itemSources) {
        const sources = this.itemSources[materialItemId];
        const sourceIndex = sources.findIndex(s => s.id === itemSourceId);
        
        if (sourceIndex !== -1) {
          // Update the item source
          updatedSource = {
            ...sources[sourceIndex],
            out_of_date_url: true,
            updated_at: new Date().toISOString()
          };
          
          // Store the update
          this.updates.itemSources[itemSourceId] = updatedSource;
          
          logger.info(`Marked item source ${itemSourceId} URL as out of date`);
          break;
        }
      }
      
      if (!updatedSource) {
        throw new Error(`Item source ${itemSourceId} not found`);
      }
      
      return updatedSource;
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
      
      // Find the material item
      const materialItemIndex = this.materialItems.findIndex(item => item.id === materialItemId);
      
      if (materialItemIndex === -1) {
        throw new Error(`Material item ${materialItemId} not found`);
      }
      
      // Update the material item
      const updatedItem = {
        ...this.materialItems[materialItemIndex],
        cost,
        cheapest_vendor_id: cheapestVendorId,
        sale_price: salePrice,
        notes,
        updated_at: new Date().toISOString()
      };
      
      // Store the update
      this.updates.materialItems[materialItemId] = updatedItem;
      
      logger.info(`Updated material item ${materialItemId}`);
      return updatedItem;
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
      const source = this.sources[sourceId];
      
      if (!source) {
        throw new Error(`Source ${sourceId} not found`);
      }
      
      return source;
    } catch (error) {
      logger.error(`Error fetching source: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get all updates made during the test
   * @returns {Object} All updates
   */
  getUpdates() {
    return this.updates;
  }
}

export default new MockDatabaseService();
