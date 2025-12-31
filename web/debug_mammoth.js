import mammoth from 'mammoth';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const filePath = path.join(__dirname, "test-title.docx");

async function debugMammoth() {
  try {
    console.log("Processing:", filePath);
    const buffer = fs.readFileSync(filePath);
    
    const result = await mammoth.convertToHtml({ buffer: buffer }, {
      ignoreEmptyParagraphs: true,
      styleMap: [
          "p[style-name='Heading 1'] => h1:fresh",
          "p[style-name='Heading 2'] => h2:fresh",
          "p[style-name='Heading 3'] => h3:fresh",
          "p[style-name='Heading 4'] => h4:fresh",
          "p[style-name='Heading 5'] => h5:fresh",
          "p[style-name='Heading 6'] => h6:fresh",
          "p[style-name='TOC 1'] => p.toc-entry.toc-level-1",
          "p[style-name='TOC 2'] => p.toc-entry.toc-level-2",
          "p[style-name='TOC 3'] => p.toc-entry.toc-level-3",
          "p[style-name='toc 1'] => p.toc-entry.toc-level-1",
          "p[style-name='toc 2'] => p.toc-entry.toc-level-2",
          "p[style-name='toc 3'] => p.toc-entry.toc-level-3"
      ],
      includeDefaultStyleMap: true,
    });
    
    console.log("--- Raw HTML ---");
    // Print first 5000 characters to see TOC
    console.log(result.value.substring(0, 5000));
    console.log("--- End HTML (Truncated) ---");

    // Simulate DocParser logic
    // Extract TOC entries
    const tocRegex = /<p class="toc-entry[^"]*">(.*?)<\/p>/gi;
    console.log("\n--- Extracted TOC Entries ---");
    
    const titleMap = new Map();
    
    const processPotentialTitle = (fullTitle) => {
        fullTitle = fullTitle.trim();
        // Match Chinese "第X章" or numeric "1.1"
        const match = fullTitle.match(/^((?:第\s*[0-9零一二三四五六七八九十百千]+\s*章[\.\s]*)|(?:[0-9]+\.[0-9\.]*\s+))(.+)$/);
        
        if (match) {
            const titleBody = match[2].trim();
            
            if (titleBody) {
                if (!titleMap.has(titleBody)) {
                    titleMap.set(titleBody, []);
                }
                titleMap.get(titleBody).push(fullTitle);
                console.log(`  Mapped: "${titleBody}" -> "${fullTitle}"`);
            }
        }
    };

    let tocMatch;
    while ((tocMatch = tocRegex.exec(result.value)) !== null) {
        // In real browser DOM, textContent would resolve HTML entities and include tabs if present.
        // Here we simulate textContent by using the raw string (which has tabs as \t if mammoth preserved them)
        // But wait, mammoth output in result.value is HTML string. Tabs might be &#9; or literal tabs.
        // Let's check our previous log: "TOC Entry (JSON): "目录\t2第1章. 系统介绍\t4""
        // So they are literal tabs in the string.
        
        const text = tocMatch[1];
        console.log(`Processing Entry: ${JSON.stringify(text)}`);

        if (text.includes('\t')) {
            const parts = text.split('\t');
            processPotentialTitle(parts[0]);
            for (let i = 1; i < parts.length - 1; i++) {
                let part = parts[i].replace(/^\d+/, '').trim();
                processPotentialTitle(part);
            }
        } else {
            let cleanText = text.replace(/\s*\d+$/, '').trim();
            processPotentialTitle(cleanText);
        }
    }

    const headers = extractHeaders(result.value);
    console.log("\n--- Extracted Headers ---");
    headers.forEach((h, i) => {
      let title = h.text;
      const originalTitle = title;
      
      // Apply TOC mapping
      const mappedTitles = titleMap.get(title.trim());
      if (mappedTitles && mappedTitles.length > 0) {
          title = mappedTitles.shift() || title;
          console.log(`  [Replaced via TOC]: "${originalTitle}" -> "${title}"`);
      }
      
      // Current Regex in docParser.ts
      if (!/^第\s*[0-9零一二三四五六七八九十百千]+\s*章/.test(title)) {
        title = title.replace(/^(\d+([\.\、]\d+)*[\.\、\s]+)(?=[^\d])/, '').trim();
      }
      
      console.log(`[${i}] Tag: ${h.tagName}, Original: "${originalTitle}", Final: "${title}"`);

      // Check TOC logic
      const isChineseChapter = /^第\s*[0-9零一二三四五六七八九十百千]+\s*章/.test(title);
      console.log(`    isChineseChapter: ${isChineseChapter}`);
    });

  } catch (error) {
    console.error("Error:", error);
  }
}

function extractHeaders(html) {
    // Simple regex to extract h1-h6 content
    const regex = /<(h[1-6])[^>]*>(.*?)<\/\1>/gi;
    const headers = [];
    let match;
    while ((match = regex.exec(html)) !== null) {
        // Strip HTML tags from content
        const text = match[2].replace(/<[^>]+>/g, '').trim();
        headers.push({ tagName: match[1], text });
    }
    return headers;
}

debugMammoth();
