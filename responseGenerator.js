// responseGenerator.js
function generateResponse(filePath, codeContent) {
  return `${filePath}\n\`\`\`javascript\n${codeContent}\n\`\`\``;
}

module.exports = { generateResponse };
