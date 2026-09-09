# 英文 OCR 训练数据

`eng.traineddata.gz` 来自 [tesseract-ocr/tessdata_fast](https://github.com/tesseract-ocr/tessdata_fast)
的 `eng.traineddata`，许可证为 Apache-2.0。原始文件约 4.1MB，gzip 后约 2MB。

框选英文正文需要尽快给出结果，选用 fast 而不是体积更大、识别更慢的 best。
npm 上的 `@tesseract.js-data/eng` 只有 best_int（约 3MB）和完整版（约 10.9MB），没有 fast。
把数据放进仓库使离线构建可重复，也让 CI 不必依赖 GitHub raw 的可用性。
