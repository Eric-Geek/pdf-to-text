/* app.js */

// ===== 常量定义 =====
const TEXT_THRESHOLD = 30; // 文本提取阈值，少于此字符数时启用 OCR
const BINARIZE_THRESHOLD = 180; // 二值化阈值（可选功能，默认关闭）
const ENABLE_BINARIZATION = false; // 是否启用二值化

// ===== 全局状态 =====
let currentPDF = null;
let abortFlag = false;
let processingFileName = '';

// ===== DOM 元素 =====
const elements = {
    file: document.getElementById('file'),
    fileInfo: document.getElementById('file-info'),
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
    output: document.getElementById('output')
};

// ===== 事件监听 =====
elements.file.addEventListener('change', handleFileSelect);
elements.start.addEventListener('click', startProcessing);
elements.cancel.addEventListener('click', cancelProcessing);
elements.download.addEventListener('click', downloadTxt);
elements.copy.addEventListener('click', copyAll);

// ===== 文件选择处理 =====
async function handleFileSelect(event) {
    const file = event.target.files[0];
    if (!file || file.type !== 'application/pdf') {
        status('请选择有效的 PDF 文件');
        return;
    }

    processingFileName = file.name.replace(/\.pdf$/i, '');
    elements.fileInfo.textContent = `已选择: ${file.name}`;
    
    try {
        const arrayBuffer = await file.arrayBuffer();
        const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
        currentPDF = await loadingTask.promise;
        
        elements.fileInfo.textContent = `已选择: ${file.name} (${currentPDF.numPages} 页)`;
        elements.start.disabled = false;
        status(`PDF 加载成功，共 ${currentPDF.numPages} 页`);
    } catch (error) {
        console.error('PDF 加载失败:', error);
        status('PDF 加载失败，请检查文件是否损坏');
        currentPDF = null;
        elements.start.disabled = true;
    }
}

// ===== 主处理流程 =====
async function startProcessing() {
    if (!currentPDF) return;

    // 重置状态
    abortFlag = false;
    elements.output.value = '';
    setProgress(0, 100);
    
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
        status('未指定有效页码，将处理所有页面');
        for (let i = 1; i <= currentPDF.numPages; i++) {
            pageRange.push(i);
        }
    }
    
    status(`开始处理 ${pageRange.length} 页...`);
    
    let worker = null;
    let processedPages = 0;
    const results = [];
    
    try {
        // 逐页处理
        for (const pageNum of pageRange) {
            if (abortFlag) {
                status('处理已取消');
                break;
            }
            
            status(`正在处理第 ${pageNum} 页 (${processedPages + 1}/${pageRange.length})...`);
            
            try {
                const page = await currentPDF.getPage(pageNum);
                let pageText = '';
                
                // 优先尝试文本提取
                if (preferText) {
                    const textContent = await page.getTextContent();
                    pageText = textContent.items.map(item => item.str).join(' ').trim();
                    
                    if (pageText.length >= TEXT_THRESHOLD) {
                        console.log(`第 ${pageNum} 页使用文本提取 (${pageText.length} 字符)`);
                        results.push(`=== 第 ${pageNum} 页 ===\n${pageText}\n`);
                        processedPages++;
                        setProgress(processedPages, pageRange.length);
                        continue;
                    }
                }
                
                // 文本过少，使用 OCR
                console.log(`第 ${pageNum} 页需要 OCR 识别`);
                
                // 延迟创建 worker（仅在需要时）
                if (!worker) {
                    status('首次加载 OCR 语言包，请稍候...');
                    worker = await createOCRWorker(lang);
                }
                
                const ocrText = await ocrPage(page, worker, scale, pageNum, processedPages, pageRange.length);
                
                results.push(`=== 第 ${pageNum} 页 (OCR) ===\n${ocrText}\n`);
                
            } catch (pageError) {
                console.error(`第 ${pageNum} 页处理失败:`, pageError);
                results.push(`=== 第 ${pageNum} 页 ===\n[处理失败: ${pageError.message}]\n`);
            }
            
            processedPages++;
            setProgress(processedPages, pageRange.length);
        }
        
    } finally {
        // 清理资源
        if (worker) {
            await worker.terminate();
        }
        
        // 更新结果
        elements.output.value = results.join('\n');
        
        // 恢复 UI 状态
        elements.start.disabled = false;
        elements.cancel.disabled = true;
        elements.file.disabled = false;
        elements.download.disabled = results.length === 0;
        elements.copy.disabled = results.length === 0;
        
        const elapsedTime = ((Date.now() - startTime) / 1000).toFixed(1);
        
        if (abortFlag) {
            status(`处理已取消，完成 ${processedPages}/${pageRange.length} 页，耗时 ${elapsedTime} 秒`);
        } else {
            status(`处理完成！共 ${processedPages} 页，耗时 ${elapsedTime} 秒`);
        }
    }
}

// ===== 创建 OCR Worker =====
async function createOCRWorker(lang) {
    // 创建 worker 时不传递 logger
    const worker = await Tesseract.createWorker();
    
    // 显示加载状态
    status('正在加载语言包，首次加载可能需要较长时间...');
    
    await worker.loadLanguage(lang);
    await worker.initialize(lang);
    
    return worker;
}

// ===== OCR 单页处理 =====
async function ocrPage(page, worker, scale, pageNum, processedPages, totalPages) {
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    
    try {
        // 渲染 PDF 页面到 Canvas
        await page.render({
            canvasContext: context,
            viewport: viewport
        }).promise;
        
        // 可选：二值化处理
        if (ENABLE_BINARIZATION) {
            binarizeCanvas(canvas, context, BINARIZE_THRESHOLD);
        }
        
        // 更新状态
        status(`正在识别第 ${pageNum} 页...`);
        
        // OCR 识别
        const result = await worker.recognize(canvas);
        
        return result.data.text.trim();
        
    } finally {
        // 释放 Canvas 内存
        canvas.width = 0;
        canvas.height = 0;
    }
}

// ===== 二值化处理（可选） =====
function binarizeCanvas(canvas, context, threshold) {
    const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;
    
    for (let i = 0; i < data.length; i += 4) {
        const gray = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
        const value = gray > threshold ? 255 : 0;
        data[i] = data[i + 1] = data[i + 2] = value;
    }
    
    context.putImageData(imageData, 0, 0);
}

// ===== 页码解析 =====
function parsePages(input, totalPages) {
    if (!input || !input.trim()) return [];
    
    const pages = new Set();
    const parts = input.split(',');
    
    for (const part of parts) {
        const trimmed = part.trim();
        
        if (trimmed.includes('-')) {
            // 范围处理
            const [start, end] = trimmed.split('-').map(n => parseInt(n.trim()));
            if (!isNaN(start) && !isNaN(end)) {
                for (let i = Math.max(1, start); i <= Math.min(totalPages, end); i++) {
                    pages.add(i);
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

// ===== 取消处理 =====
function cancelProcessing() {
    abortFlag = true;
    elements.cancel.disabled = true;
}

// ===== 导出文本文件 =====
function downloadTxt() {
    const text = elements.output.value;
    if (!text) return;
    
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    
    a.href = url;
    a.download = `${processingFileName || 'output'}.txt`;
    a.click();
    
    URL.revokeObjectURL(url);
    showToast('文件已导出', 'success');
}

// ===== 复制到剪贴板 =====
async function copyAll() {
    const text = elements.output.value;
    if (!text) return;
    
    try {
        await navigator.clipboard.writeText(text);
        showToast('已复制到剪贴板', 'success');
    } catch (err) {
        // 降级方案
        elements.output.select();
        document.execCommand('copy');
        showToast('已复制到剪贴板', 'success');
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

// ===== 初始化 =====
status('等待选择文件...');