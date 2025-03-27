import { GoogleGenerativeAI } from '@google/generative-ai';
import fs from 'fs';
import dotenv from 'dotenv';
import { logger } from '../utils/logger.js';

// Load environment variables
dotenv.config();

// Initialize Gemini API
const apiKey = process.env.GEMINI_API_KEY;

if (!apiKey) {
  logger.error('Gemini API key is missing in environment variables');
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(apiKey);
const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' }); // Using Gemini 2.0 Flash as specified

/**
 * Service for interacting with Gemini API
 */
class GeminiService {
  /**
   * Extract price from a screenshot using Gemini API
   * @param {string} screenshotPath - Path to the screenshot file
   * @param {string} productName - Name of the product (for context)
   * @returns {Promise<number|null>} Extracted price or null if not found
   */
  async extractPriceFromImage(screenshotPath, productName) {
    try {
      logger.info(`Extracting price from screenshot for ${productName}`);
      
      // Read the image file
      const imageData = await fs.promises.readFile(screenshotPath);
      const base64Image = imageData.toString('base64');
      
      // Prepare the prompt
      const prompt = `
        Look at this product page screenshot and extract the current price of the product.
        Product name: ${productName}
        
        INSTRUCTIONS:
        1. Find the most prominent price displayed for this product.
        2. If there are multiple prices (e.g., regular and sale price), choose the CURRENT selling price (usually the sale price or the price in larger font).
        3. Ignore shipping costs, taxes, or any additional fees.
        4. Be aware that some websites (especially WinSupply and Home Depot) display cents as superscript. For example, "$19⁹⁸" means "$19.98".
        4. For items sold in multiple feet (e.g., "5/8" OD x 50' Copper Refrigeration Tubing Coil" or "2 in. x 10ft White Schedule 40 PVC Solid Core"), calculate the price per foot.
           - Example: If a 10ft pipe costs $19.90, the price per foot is $1.99
           - Example: If a 50' coil costs $75.00, the price per foot is $1.50
        5. If the price is shown as a range (e.g., $10-$15), extract the lower price.
        6. Return your answer in this exact format:
           PRICE: [numeric price]
           PER_FOOT: [true/false]
           TOTAL_FEET: [number of feet, if applicable]
           
           For example:
           PRICE: 29.99
           PER_FOOT: false
           TOTAL_FEET: 0
           
           Or for items sold by length:
           PRICE: 1.99
           PER_FOOT: true
           TOTAL_FEET: 10
        
        7. If you cannot find a clear price, respond with:
           PRICE: NO_PRICE_FOUND
           PER_FOOT: false
           TOTAL_FEET: 0
        
        EXAMPLES:
        - If you see "$29.99" for a regular item, return:
          PRICE: 29.99
          PER_FOOT: false
          TOTAL_FEET: 0
          
        - If you see "$19.90" for a "10ft PVC pipe", return:
          PRICE: 1.99
          PER_FOOT: true
          TOTAL_FEET: 10
          
        - If you see "$75.00" for a "50' copper tubing", return:
          PRICE: 1.50
          PER_FOOT: true
          TOTAL_FEET: 50
      `;
      
      // Create image part
      const imagePart = {
        inlineData: {
          data: base64Image,
          mimeType: 'image/jpeg',
        },
      };
      
      // Generate content
      const result = await model.generateContent([prompt, imagePart]);
      const response = await result.response;
      const text = response.text().trim();
      
      // Parse the response
      const priceMatch = text.match(/PRICE:\s*([^\n]+)/);
      const perFootMatch = text.match(/PER_FOOT:\s*([^\n]+)/);
      const totalFeetMatch = text.match(/TOTAL_FEET:\s*([^\n]+)/);
      
      if (!priceMatch) {
        logger.warn(`Could not parse price from Gemini response: ${text}`);
        return null;
      }
      
      const priceText = priceMatch[1].trim();
      
      if (priceText === 'NO_PRICE_FOUND') {
        logger.warn(`No price found in screenshot for ${productName}`);
        return null;
      }
      
      const price = parseFloat(priceText);
      const perFoot = perFootMatch && perFootMatch[1].trim().toLowerCase() === 'true';
      const totalFeet = totalFeetMatch ? parseInt(totalFeetMatch[1].trim(), 10) : 0;
      
      if (isNaN(price)) {
        logger.warn(`Invalid price format in Gemini response: ${priceText}`);
        return null;
      }
      
      if (perFoot) {
        logger.info(`Extracted per-foot price ${price} for ${productName} (${totalFeet} feet total)`);
      } else {
        logger.info(`Extracted price ${price} for ${productName}`);
      }
      
      return price;
    } catch (error) {
      logger.error(`Error extracting price from image: ${error.message}`);
      return null;
    }
  }
}

export default new GeminiService();
