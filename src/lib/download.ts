/**
 * 把一段文本作为文件交给用户。
 *
 * 扩展页面里用 `<a download>`（不必声明 downloads 权限）。安卓 WebView 里 blob 下载
 * 是死的——点了什么都不会发生——所以宿主（app/MainActivity）挂了一个 `Native.saveFile`，
 * 把文件写进系统的「下载」目录。这里只认有没有这个函数，不关心自己跑在哪。
 */

/** 安卓宿主注入的桥里和文件有关的那一个方法。完整的桥见 src/app/native.ts，这里不依赖它。 */
interface FileSink {
  saveFile?: (name: string, mime: string, text: string) => string;
}

/**
 * 返回给用户看的一句话（「已保存到下载目录」），浏览器路径下返回空串——
 * 那时下载条自己会说话。
 */
export function saveTextFile(name: string, mime: string, text: string, anchor?: HTMLAnchorElement): string {
  const sink = typeof window !== "undefined" ? (window as unknown as { Native?: FileSink }).Native : undefined;
  if (sink?.saveFile) return sink.saveFile(name, mime, text);

  const a = anchor ?? document.createElement("a");
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return "";
}
