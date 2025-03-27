/**
 * Format a date as MM/DD/YYYY
 * @param {Date} date - The date to format
 * @returns {string} Formatted date string
 */
export function formatDate(date) {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const year = date.getFullYear();
  
  return `${month}/${day}/${year}`;
}

/**
 * Format a time as HH:MM AM/PM (12-hour format)
 * @param {Date} date - The date to format
 * @returns {string} Formatted time string
 */
export function formatTime(date) {
  let hours = date.getHours();
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const ampm = hours >= 12 ? 'PM' : 'AM';
  
  hours = hours % 12;
  hours = hours ? hours : 12; // Convert 0 to 12
  
  return `${hours}:${minutes} ${ampm}`;
}

/**
 * Generate notes text with vendor information and timestamp
 * @param {string} lowestPricedVendor - Name of the lowest priced vendor
 * @param {string} highestPricedVendor - Name of the highest priced vendor
 * @returns {string} Formatted notes text
 */
export function generateNotesText(lowestPricedVendor, highestPricedVendor) {
  const now = new Date();
  const dateStr = formatDate(now);
  const timeStr = formatTime(now);
  
  return `Lowest Priced Vendor: ${lowestPricedVendor}
Highest Priced Vendor: ${highestPricedVendor}
Updated on ${dateStr} at ${timeStr}`;
}
