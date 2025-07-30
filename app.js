/* app.js - 完整更新版本，包含批量处理和多格式导出 */

// ===== 常量定义 =====
const TEXT_THRESHOLD = 30; // 文本提取阈值，少于此字符数时启用 OCR
const BINARIZE_THRESHOLD = 180; // 二值化阈值（可选功能，默认关闭）
const ENABLE_BINARIZATION = false; // 是否启用二值化

// ===== 全局状态 =====
let currentPDF = null;
let abortFlag = false;
let processingFileName = '';
let rawResults = []; // 保存原始识别结果
let currentMode = 'single'; // 'single' or 'batch'
let batchFiles = [];
let batchResults = new Map(); // 存储批量处理结果
let currentBatchFile = null;

// ===== DOM 元素 =====
const elements = {
    file: document.getElementById('file'),
    batchFilesInput: document.getElementById('batch-files'),
    fileInfo: document.getElementById('file-info'),
    batchList: document.getElementById('batch-list'),
    start: document.getElementById('start'),
    cancel: document.getElementById('cancel'),
    download: document.getElementById('download'),
    copy: document.getElementById('copy'),
    lang: document.getElementById('lang'),
    scale: document.getElementById('scale'),
    pages: document.getElementById('pages'),
    preferText: document.getElementById('preferText'),
    status: document.getElementById('status'),
    bar: document.getElementById('bar'),
    output: document.getElementById('output'),
    // 文本处理相关元素
    autoFormat: document.getElementById('autoFormat'),
    mergeParagraphs: document.getElementById('mergeParagraphs'),
    removeDuplicateSpaces: document.getElementById('removeDuplicateSpaces'),
    fixPunctuation: document.getElementById('fixPunctuation'),
    lineBreakThreshold: document.getElementById('lineBreakThreshold'),
    charCount: document.getElementById('charCount'),
    wordCount: document.getElementById('wordCount'),
    // 新增元素
    exportFormat: document.getElementById('exportFormat'),
    mergeExport: document.getElementById('mergeExport'),
    batchTabs: document.getElementById('batch-tabs'),
    batchExportOption: document.getElementById('batch-export-option')
};

// ===== 模式切换 =====
document.querySelectorAll('input[name="mode"]').forEach(radio => {
    radio.addEventListener('change', (e) => {
        currentMode = e.target.value;
        updateUIMode();
    });
});

function updateUIMode() {
    if (currentMode === 'batch') {
        document.getElementById('single-file-label').style.display = 'none';
        document.getElementById('batch-file-label').style.display = 'block';
        elements.batchList.style.display = 'block';
        elements.batchTabs.style.display = 'flex';
        elements.batchExportOption.style.display = 'block';
        elements.pages.disabled = true;
        elements.pages.value = '';
        elements.pages.placeholder = 'Batch mode does not support page range';
    } else {
        document.getElementById('single-file-label').style.display = 'block';
        document.getElementById('batch-file-label').style.display = 'none';
        elements.batchList.style.display = 'none';
        elements.batchTabs.style.display = 'none';
        elements.batchExportOption.style.display = 'none';
        elements.pages.disabled = false;
        elements.pages.placeholder = 'e.g: 1-3,5,8';
    }
    
    // 重置状态
    resetState();
}

// ===== 导出管理器 =====
class ExportManager {
    constructor() {
        this.formats = {
            txt: this.exportAsTxt,
            markdown: this.exportAsMarkdown,
            json: this.exportAsJSON,
            html: this.exportAsHTML,
            csv: this.exportAsCSV
        };
    }
    
    export(format, data, fileName) {
        const exporter = this.formats[format];
        if (exporter) {
            exporter.call(this, data, fileName);
        }
    }
    
    exportAsTxt(data, fileName) {
        const content = this.prepareTextContent(data);
        this.download(content, `${fileName}.txt`, 'text/plain');
    }
    
    exportAsMarkdown(data, fileName) {
        let content = `# ${fileName}\n\n`;
        content += `> Export time: ${new Date().toLocaleString()}\n\n`;
        
        if (Array.isArray(data)) {
            data.forEach(item => {
                content += `## ${item.fileName}\n\n`;
                content += this.convertToMarkdown(item.content);
                content += '\n\n---\n\n';
            });
        } else {
            content += this.convertToMarkdown(data);
        }
        
        this.download(content, `${fileName}.md`, 'text/markdown');
    }
    
    exportAsJSON(data, fileName) {
        const jsonData = {
            exportTime: new Date().toISOString(),
            fileName: fileName,
            content: Array.isArray(data) ? data : [{
                fileName: fileName,
                content: data
            }]
        };
        
        const content = JSON.stringify(jsonData, null, 2);
        this.download(content, `${fileName}.json`, 'application/json');
    }
    
    exportAsHTML(data, fileName) {
        let html = `<!DOCTYPE html>\n<html lang="en">\n<head>\n    <meta charset="UTF-8">\n    <meta name="viewport" content="width=device-width, initial-scale=1.0">\n    <title>${fileName}</title>\n    <style>\n        body { font-family: system-ui, -apple-system, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; }\n        h1 { color: #333; }\n        .meta { color: #666; font-size: 14px; }\n        .content { white-space: pre-wrap; line-height: 1.6; }\n        .file-section { margin: 30px 0; padding: 20px; background: #f5f5f5; border-radius: 8px; }\n    </style>\n</head>\n<body>\n    <h1>${fileName}</h1>\n    <p class="meta">Export time: ${new Date().toLocaleString()}</p>\n    `;
        
        if (Array.isArray(data)) {
            data.forEach(item => {
                html += `<div class="file-section">\n                    <h2>${item.fileName}</h2>\n                    <pre class="content">${this.escapeHtml(item.content)}</pre>\n                </div>`;
            });
        } else {
            html += `<pre class="content">${this.escapeHtml(data)}</pre>`;
        }
        
        html += `</body></html>`;
        this.download(html, `${fileName}.html`, 'text/html');
    }
    
    exportAsCSV(data, fileName) {
        let csv = 'Page,Content\n';
        
        const rows = Array.isArray(data) ? data : [{ fileName, content: data }];
        
        rows.forEach(item => {
            const pages = item.content.split(/=== Page (\d+).*? ===/);
            for (let i = 1; i < pages.length; i += 2) {
                const pageNum = pages[i];
                const content = pages[i + 1] ? pages[i + 1].trim() : '';
                csv += `"${pageNum}","${content.replace(/"/g, '""')}"\n`;
            }
        });
        
        this.download(csv, `${fileName}.csv`, 'text/csv');
    }
    
    prepareTextContent(data) {
        if (Array.isArray(data)) {
            return data.map(item => `========== ${item.fileName} ==========\n\n${item.content}`).join('\n\n\n');
        }
        return data;
    }
    
    convertToMarkdown(text) {
        return text.replace(/=== Page (\d+).*? ===/g, '### Page $1');
    }
    
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
    
    download(content, fileName, mimeType) {
        const blob = new Blob([content], { type: mimeType + ';charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        a.click();
        URL.revokeObjectURL(url);
        showToast(`Exported as ${fileName}`, 'success');
    }
}

const exportManager = new ExportManager();

// ===== 批量处理器 =====
class BatchProcessor {
    constructor() {
        this.queue = [];
        this.results = new Map();
        this.currentIndex = 0;
    }
    
    reset() {
        this.queue = [];
        this.results.clear();
        this.currentIndex = 0;
    }
    
    addFiles(files) {
        this.queue = Array.from(files).filter(file => file.type === 'application/pdf');
        this.updateBatchList();
    }
    
    updateBatchList() {
        const listHtml = this.queue.map((file, index) => `\n            <div class="batch-item" data-index="${index}">\n                <span class="batch-item-name" title="${file.name}">${file.name}</span>\n                <span class="batch-item-status pending">Pending</span>\n            </div>\n        `).join('');
        
        elements.batchList.innerHTML = listHtml;
        elements.fileInfo.textContent = `Selected ${this.queue.length} files`;
    }
    
    updateItemStatus(index, status, text = '') {
        const item = elements.batchList.querySelector(`[data-index="${index}"]`);
        if (item) {
            const statusElem = item.querySelector('.batch-item-status');
            statusElem.className = `batch-item-status ${status}`;
            statusElem.textContent = text || this.getStatusText(status);
        }
    }
    
    getStatusText(status) {
        const texts = {
            pending: 'Pending',
            processing: 'Processing...', 
            success: 'Completed',
            error: 'Failed'
        };
        return texts[status] || status;
    }
    
    async processNext() {
        if (this.currentIndex >= this.queue.length || abortFlag) {
            return false;
        }
        
        const file = this.queue[this.currentIndex];
        this.updateItemStatus(this.currentIndex, 'processing');
        
        try {
            const result = await this.processFile(file, this.currentIndex);
            this.results.set(file.name, {
                fileName: file.name,
                content: result,
                success: true
            });
            this.updateItemStatus(this.currentIndex, 'success');
            this.addBatchTab(file.name, this.currentIndex);
        } catch (error) {
            console.error(`处理文件 ${file.name} 失败:`, error);
            this.results.set(file.name, {
                fileName: file.name,
                content: `Processing failed: ${error.message}`,
                success: false
            });
            this.updateItemStatus(this.currentIndex, 'error');
        }
        
        this.currentIndex++;
        return true;
    }
    
    async processFile(file, index) {
        const arrayBuffer = await file.arrayBuffer();
        const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
        const pdf = await loadingTask.promise;
        
        status(`Processing ${file.name} (${index + 1}/${this.queue.length})`);
        
        const results = [];
        let worker = null;
        
        try {
            for (let i = 1; i <= pdf.numPages; i++) {
                if (abortFlag) break;
                
                const page = await pdf.getPage(i);
                let pageText = '';
                
                // 优先文本提取
                if (elements.preferText.checked) {
                    const textContent = await page.getTextContent();
                    pageText = textContent.items.map(item => item.str).join(' ').trim();
                    
                    if (pageText.length >= TEXT_THRESHOLD) {
                        results.push({
                            pageNum: i,
                            text: pageText,
                            isOCR: false
                        });
                        
                        // 更新进度 - 修复批量处理进度条计算
                        const fileProgress = i / pdf.numPages; // 当前文件的进度 (0-1)
                        const totalProgress = (index + fileProgress) / this.queue.length; // 总体进度 (0-1)
                        setProgress(totalProgress * 100, 100);
                        continue;
                    }
                }
                
                // OCR 处理
                if (!worker) {
                    worker = await createOCRWorker(elements.lang.value);
                }
                
                const ocrText = await ocrPage(page, worker, parseFloat(elements.scale.value));
                results.push({
                    pageNum: i,
                    text: ocrText,
                    isOCR: true
                });
                
                // 更新进度 - 修复批量处理进度条计算
                const fileProgress = i / pdf.numPages; // 当前文件的进度 (0-1)
                const totalProgress = (index + fileProgress) / this.queue.length; // 总体进度 (0-1)
                setProgress(totalProgress * 100, 100);
            }
        } finally {
            if (worker) {
                await worker.terminate();
            }
        }
        
        // 处理文本
        const processor = new TextProcessor({
            autoFormat: elements.autoFormat.checked,
            mergeParagraphs: elements.mergeParagraphs.checked,
            removeDuplicateSpaces: elements.removeDuplicateSpaces.checked,
            fixPunctuation: elements.fixPunctuation.checked,
            lineBreakThreshold: parseFloat(elements.lineBreakThreshold.value)
        });
        
        const processedTexts = results.map(result => {
            const header = `=== Page ${result.pageNum}${result.isOCR ? ' (OCR)' : ''} ===`;
            const text = processor.process(result.text);
            return `${header}\n${text}`;
        });
        
        return processedTexts.join('\n\n');
    }
    
    addBatchTab(fileName, index) {
        const tab = document.createElement('button');
        tab.className = 'batch-tab';
        tab.textContent = fileName.replace(/\.pdf$/i, '');
        tab.title = fileName;
        tab.dataset.filename = fileName;
        tab.onclick = () => this.showBatchResult(fileName);
        
        elements.batchTabs.appendChild(tab);
        
        // 自动显示第一个完成的文件
        if (index === 0) {
            this.showBatchResult(fileName);
        }
    }
    
    showBatchResult(fileName) {
        const result = this.results.get(fileName);
        if (result) {
            elements.output.value = result.content;
            updateTextStats();
            currentBatchFile = fileName;
            
            // 更新标签页状态
            document.querySelectorAll('.batch-tab').forEach(tab => {
                tab.classList.toggle('active', tab.dataset.filename === fileName);
            });
        }
    }
    
    getAllResults() {
        return Array.from(this.results.values());
    }
}

const batchProcessor = new BatchProcessor();

// ===== 文本处理器 =====
class TextProcessor {
    constructor(options = {}) {
        this.options = {
            autoFormat: true,
            mergeParagraphs: true,
            removeDuplicateSpaces: true,
            fixPunctuation: true,
            lineBreakThreshold: 1.5,
            ...options
        };
    }

    process(text) {
        if (!this.options.autoFormat) return text;

        let processed = text;

        // 1. 去除多余空格和空行
        if (this.options.removeDuplicateSpaces) {
            processed = this.removeExtraSpaces(processed);
        }

        // 2. 修正标点符号
        if (this.options.fixPunctuation) {
            processed = this.fixPunctuation(processed);
        }

        // 3. 合并段落
        if (this.options.mergeParagraphs) {
            processed = this.mergeParagraphs(processed);
        }

        // 4. 格式化段落
        processed = this.formatParagraphs(processed);

        return processed;
    }

    removeExtraSpaces(text) {
        // 去除行首行尾空格
        text = text.split('\n').map(line => line.trim()).join('\n');
        
        // 去除多个连续空格
        text = text.replace(/[ \t]+/g, ' ');
        
        // 去除多个连续空行
        text = text.replace(/\n{3,}/g, '\n\n');
        
        return text;
    }

    fixPunctuation(text) {
        // 中文标点后不应有空格
        text = text.replace(/([，。！？；：、""'（）【】《》])\s+/g, '$1');
        
        // 英文标点后应有空格
        text = text.replace(/([,.!?;:])\s*([a-zA-Z])/g, '$1 $2');
        
        // 修正引号
        text = text.replace(/[""]/g, '"');
        text = text.replace(/['']/g, "'");
        
        // 修正破折号
        text = text.replace(/—{2,}/g, '——');
        text = text.replace(/\s*—+\s*/g, '——');
        
        return text;
    }

    mergeParagraphs(text) {
        const lines = text.split('\n');
        const merged = [];
        let currentParagraph = '';
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            const nextLine = i + 1 < lines.length ? lines[i + 1].trim() : '';
            
            if (!line) {
                // 空行，结束当前段落
                if (currentParagraph) {
                    merged.push(currentParagraph);
                    currentParagraph = '';
                }
                continue;
            }
            
            // 判断是否应该合并到当前段落
            const shouldMerge = this.shouldMergeLine(line, nextLine, currentParagraph);
            
            if (shouldMerge && currentParagraph) {
                // 合并时根据语言决定是否添加空格
                const separator = this.needsSpace(currentParagraph, line) ? ' ' : '';
                currentParagraph += separator + line;
            } else {
                // 开始新段落
                if (currentParagraph) {
                    merged.push(currentParagraph);
                }
                currentParagraph = line;
            }
        }
        
        // 添加最后一个段落
        if (currentParagraph) {
            merged.push(currentParagraph);
        }
        
        return merged.join('\n\n');
    }

    shouldMergeLine(line, nextLine, currentParagraph) {
        // 检查是否是标题（通常较短且可能全大写或有特殊格式）
        if (line.length < 20 && (line === line.toUpperCase() || /^第[一二三四五六七八九十\d]+[章节部分]/.test(line))) {
            return false;
        }
        
        // 检查是否是列表项
        if (/^[\d一二三四五六七八九十]+[\.、\s]/.test(line) || /^[·•◆▪➢]/.test(line)) {
            return false;
        }
        
        // 检查行尾是否是完整句子
        const endsWithPunctuation = /[.!?。！？]$/.test(line);
        if (endsWithPunctuation) {
            return false;
        }
        
        // 如果当前段落为空，不合并
        if (!currentParagraph) {
            return false;
        }
        
        // 基于行长度判断
        const avgLineLength = (currentParagraph.length + line.length) / 2;
        const threshold = avgLineLength * this.options.lineBreakThreshold;
        
        return line.length > threshold * 0.5;
    }

    needsSpace(text1, text2) {
        // 检查是否需要在合并时添加空格
        const lastChar = text1[text1.length - 1];
        const firstChar = text2[0];
        
        // 中文字符之间不需要空格 - 修复正则表达式
        const isChinese = (char) => /[\u4e00-\u9fff]/.test(char);
        if (isChinese(lastChar) || isChinese(firstChar)) {
            return false;
        }
        
        // 英文单词之间需要空格
        const isEnglish = (char) => /[a-zA-Z]/.test(char);
        if (isEnglish(lastChar) && isEnglish(firstChar)) {
            return true;
        }
        
        return false;
    }

    formatParagraphs(text) {
        const paragraphs = text.split('\n\n');
        
        return paragraphs.map(para => {
            // 添加段落缩进（中文段落）
            if (/[\u4e00-\u9fff]/.test(para.substring(0, 10))) {
                return '　　' + para; // 使用全角空格缩进
            }
            return para;
        }).join('\n\n');
    }
}

// ===== 页码解析函数 =====
function parsePages(input, totalPages) {
    if (!input || !input.trim()) return [];
    
    const pages = new Set();
    const parts = input.split(',');
    
    for (const part of parts) {
        const trimmed = part.trim();
        
        if (trimmed.includes('-')) {
            // 范围处理
            const rangeParts = trimmed.split('-');
            if (rangeParts.length === 2) {
                const start = parseInt(rangeParts[0].trim());
                const end = parseInt(rangeParts[1].trim());
                
                if (!isNaN(start) && !isNaN(end)) {
                    for (let i = Math.max(1, start); i <= Math.min(totalPages, end); i++) {
                        pages.add(i);
                    }
                }
            }
        } else {
            // 单个页码
            const pageNum = parseInt(trimmed);
            if (!isNaN(pageNum) && pageNum >= 1 && pageNum <= totalPages) {
                pages.add(pageNum);
            }
        }
    }
    
    return Array.from(pages).sort((a, b) => a - b);
}

// ===== OCR 相关函数 =====
async function createOCRWorker(lang) {
    const worker = await Tesseract.createWorker(lang, 1, {
        logger: m => {
            if (m.status === 'recognizing text') {
                const progress = Math.round(m.progress * 100);
                status(`OCR recognizing... ${progress}%`);
            }
        }
    });
    return worker;
}

async function ocrPage(page, worker, scale = 2, pageNum = 1, currentPage = 0, totalPages = 1) {
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    
    canvas.height = viewport.height;
    canvas.width = viewport.width;
    
    // 渲染页面到 canvas
    await page.render({
        canvasContext: context,
        viewport: viewport
    }).promise;
    
    // 可选：图像预处理（二值化）
    if (ENABLE_BINARIZATION) {
        binarizeCanvas(canvas, context);
    }
    
    // OCR 识别
    status(`OCR recognizing page ${pageNum} (${currentPage + 1}/${totalPages})...`);
    
    const { data: { text } } = await worker.recognize(canvas);
    
    return text.trim();
}

function binarizeCanvas(canvas, context) {
    const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;
    
    for (let i = 0; i < data.length; i += 4) {
        const gray = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
        const binary = gray > BINARIZE_THRESHOLD ? 255 : 0;
        
        data[i] = binary;     // R
        data[i + 1] = binary; // G
        data[i + 2] = binary; // B
        // data[i + 3] 保持不变 (Alpha)
    }
    
    context.putImageData(imageData, 0, 0);
}

// ===== 结果显示和处理 =====
function displayResults() {
    if (rawResults.length === 0) {
        elements.output.value = 'No content recognized';
        return;
    }
    
    // 创建文本处理器
    const processor = new TextProcessor({
        autoFormat: elements.autoFormat.checked,
        mergeParagraphs: elements.mergeParagraphs.checked,
        removeDuplicateSpaces: elements.removeDuplicateSpaces.checked,
        fixPunctuation: elements.fixPunctuation.checked,
        lineBreakThreshold: parseFloat(elements.lineBreakThreshold.value)
    });
    
    // 处理每页结果
    const processedTexts = rawResults.map(result => {
        const header = `=== Page ${result.pageNum}${result.isOCR ? ' (OCR)' : ''} ===`;
        const text = processor.process(result.text);
        return `${header}\n${text}`;
    });
    
    // 合并所有页面
    const finalText = processedTexts.join('\n\n');
    elements.output.value = finalText;
    
    // 更新统计信息
    updateTextStats();
}

function updateTextStats() {
    const text = elements.output.value;
    const charCount = text.length;
    const wordCount = text.split(/\s+/).filter(word => word.length > 0).length;
    
    elements.charCount.textContent = `${charCount} characters`;
    elements.wordCount.textContent = `${wordCount} words`;
}

// ===== 事件监听 =====
elements.file.addEventListener('change', handleFileSelect);
elements.batchFilesInput.addEventListener('change', handleBatchFileSelect);
elements.start.addEventListener('click', startProcessing);
elements.cancel.addEventListener('click', cancelProcessing);
elements.download.addEventListener('click', downloadResult);
elements.copy.addEventListener('click', copyAll);
elements.output.addEventListener('input', updateTextStats);

// ===== 文件选择处理 =====
async function handleFileSelect(event) {
    const file = event.target.files[0];
    if (!file || file.type !== 'application/pdf') {
        status('Please select a valid PDF file');
        return;
    }

    processingFileName = file.name.replace(/\.pdf$/i, '');
    elements.fileInfo.textContent = `Selected: ${file.name}`;
    
    try {
        const arrayBuffer = await file.arrayBuffer();
        const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
        currentPDF = await loadingTask.promise;
        
        elements.fileInfo.textContent = `Selected: ${file.name} (${currentPDF.numPages} pages)`;
        elements.start.disabled = false;
        status(`PDF loaded successfully, ${currentPDF.numPages} pages total`);
    } catch (error) {
        console.error('PDF loading failed:', error);
        status('PDF loading failed, please check if the file is corrupted');
        currentPDF = null;
        elements.start.disabled = true;
    }
}

// ===== 批量文件选择 =====
function handleBatchFileSelect(event) {
    const files = event.target.files;
    if (files.length === 0) return;
    
    batchProcessor.reset();
    batchProcessor.addFiles(files);
    
    elements.start.disabled = false;
    status(`Selected ${batchProcessor.queue.length} files, ready for batch processing`);
}

// ===== 主处理流程 =====
async function startProcessing() {
    if (currentMode === 'batch') {
        await startBatchProcessing();
    } else {
        await startSingleProcessing();
    }
}

// ===== 单文件处理 =====
async function startSingleProcessing() {
    if (!currentPDF) return;

    // 重置状态
    abortFlag = false;
    rawResults = [];
    elements.output.value = '';
    setProgress(0, 100);
    updateTextStats();
    
    // 更新 UI 状态
    elements.start.disabled = true;
    elements.cancel.disabled = false;
    elements.file.disabled = true;
    
    const startTime = Date.now();
    const lang = elements.lang.value;
    const scale = parseFloat(elements.scale.value);
    const preferText = elements.preferText.checked;
    const pageRange = parsePages(elements.pages.value, currentPDF.numPages);
    
    if (pageRange.length === 0) {
        status('No valid page range specified, will process all pages');
        for (let i = 1; i <= currentPDF.numPages; i++) {
            pageRange.push(i);
        }
    }
    
    status(`Starting to process ${pageRange.length} pages...`);
    
    let worker = null;
    let processedPages = 0;
    
    try {
        // 逐页处理
        for (const pageNum of pageRange) {
            if (abortFlag) {
                status('Processing cancelled');
                break;
            }
            
            status(`Processing page ${pageNum} (${processedPages + 1}/${pageRange.length})...`);
            
            try {
                const page = await currentPDF.getPage(pageNum);
                let pageText = '';
                
                // 优先尝试文本提取
                if (preferText) {
                    const textContent = await page.getTextContent();
                    pageText = textContent.items.map(item => item.str).join(' ').trim();
                    
                    if (pageText.length >= TEXT_THRESHOLD) {
                        console.log(`第 ${pageNum} 页使用文本提取 (${pageText.length} 字符)`);
                        rawResults.push({
                            pageNum,
                            text: pageText,
                            isOCR: false
                        });
                        processedPages++;
                        setProgress(processedPages, pageRange.length);
                        continue;
                    }
                }
                
                // 文本过少，使用 OCR
                console.log(`第 ${pageNum} 页需要 OCR 识别`);
                
                // 延迟创建 worker（仅在需要时）
                if (!worker) {
                    status('Loading OCR language pack for the first time, please wait...');
                    worker = await createOCRWorker(lang);
                }
                
                const ocrText = await ocrPage(page, worker, scale, pageNum, processedPages, pageRange.length);
                
                rawResults.push({
                    pageNum,
                    text: ocrText,
                    isOCR: true
                });
                
            } catch (pageError) {
                console.error(`Page ${pageNum} processing failed:`, pageError);
                rawResults.push({
                    pageNum,
                    text: `[Processing failed: ${pageError.message}]`,
                    isOCR: false,
                    error: true
                });
            }
            
            processedPages++;
            setProgress(processedPages, pageRange.length);
        }
        
    } finally {
        // 清理资源
        if (worker) {
            await worker.terminate();
        }
        
        // 处理和显示结果
        displayResults();
        
        // 恢复 UI 状态
        elements.start.disabled = false;
        elements.cancel.disabled = true;
        elements.file.disabled = false;
        elements.download.disabled = rawResults.length === 0;
        elements.copy.disabled = rawResults.length === 0;
        
        const elapsedTime = ((Date.now() - startTime) / 1000).toFixed(1);
        
        if (abortFlag) {
            status(`Processing cancelled, completed ${processedPages}/${pageRange.length} pages, took ${elapsedTime} seconds`);
        } else {
            status(`Processing completed! Total ${processedPages} pages, took ${elapsedTime} seconds`);
        }
    }
}

// ===== 批量处理 =====
async function startBatchProcessing() {
    if (batchProcessor.queue.length === 0) return;
    
    // 重置状态
    abortFlag = false;
    batchResults.clear();
    elements.batchTabs.innerHTML = '';
    elements.output.value = '';
    setProgress(0, 100);
    updateTextStats();
    
    // 更新 UI 状态
    elements.start.disabled = true;
    elements.cancel.disabled = false;
    elements.batchFilesInput.disabled = true;
    
    const startTime = Date.now();
    
    try {
        // 逐个处理文件
        while (await batchProcessor.processNext()) {
            if (abortFlag) {
                status('Batch processing cancelled');
                break;
            }
        }
        
        const results = batchProcessor.getAllResults();
        
        // 恢复 UI 状态
        elements.start.disabled = false;
        elements.cancel.disabled = true;
        elements.batchFilesInput.disabled = false;
        elements.download.disabled = results.length === 0;
        elements.copy.disabled = results.length === 0;
        
        const elapsedTime = ((Date.now() - startTime) / 1000).toFixed(1);
        const successCount = results.filter(r => r.success).length;
        
        status(`Batch processing completed! Successfully processed ${successCount}/${batchProcessor.queue.length} files, took ${elapsedTime} seconds`);
        
    } catch (error) {
        console.error('Batch processing failed:', error);
        status('Batch processing failed: ' + error.message);
        
        elements.start.disabled = false;
        elements.cancel.disabled = true;
        elements.batchFilesInput.disabled = false;
    }
}

// ===== 导出结果 =====
function downloadResult() {
    const format = elements.exportFormat.value;
    
    if (currentMode === 'batch') {
        const results = batchProcessor.getAllResults();
        if (results.length === 0) return;
        
        if (elements.mergeExport.checked) {
            // 合并导出
            const mergedContent = results.map(r => r.content).join('\n\n\n');
            exportManager.export(format, mergedContent, 'merged_output');
        } else {
            // 分别导出
            results.forEach(result => {
                const fileName = result.fileName.replace(/\.pdf$/i, '');
                exportManager.export(format, result.content, fileName);
            });
        }
    } else {
        // 单文件导出
        const text = elements.output.value;
        if (!text) return;
        
        exportManager.export(format, text, processingFileName || 'output');
    }
}

// ===== 取消处理 =====
function cancelProcessing() {
    abortFlag = true;
    elements.cancel.disabled = true;
}

// ===== 复制到剪贴板 =====
async function copyAll() {
    const text = elements.output.value;
    if (!text) return;
    
    try {
        await navigator.clipboard.writeText(text);
        showToast('Copied to clipboard', 'success');
    } catch (err) {
        // 降级方案
        elements.output.select();
        document.execCommand('copy');
        showToast('Copied to clipboard', 'success');
    }
}

// ===== 更新状态信息 =====
function status(message) {
    elements.status.textContent = message;
}

// ===== 更新进度条 =====
function setProgress(current, total) {
    const percentage = Math.min(100, (current / total) * 100);
    elements.bar.style.width = `${percentage}%`;
}

// ===== Toast 提示 =====
function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    
    document.body.appendChild(toast);
    
    // 触发显示动画
    requestAnimationFrame(() => {
        toast.classList.add('show');
    });
    
    // 3秒后移除
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => {
            document.body.removeChild(toast);
        }, 300);
    }, 3000);
}

// ===== 重置状态 =====
function resetState() {
    currentPDF = null;
    abortFlag = false;
    processingFileName = '';
    rawResults = [];
    batchResults.clear();
    currentBatchFile = null;
    
    elements.output.value = '';
    elements.fileInfo.textContent = '';
    elements.batchList.innerHTML = '';
    elements.batchTabs.innerHTML = '';
    elements.start.disabled = true;
    elements.cancel.disabled = true;
    elements.download.disabled = true;
    elements.copy.disabled = true;
    
    setProgress(0, 100);
    updateTextStats();
    status('Waiting for file selection...');
}

// ===== 初始化 =====
status('Waiting for file selection...');
