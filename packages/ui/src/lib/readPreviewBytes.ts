/** Caller applies the preview size limit; range access stays with the existing file service. */
export async function readPreviewBytes(
  totalBytes: number,
  chunkSize: number,
  readRange: (offset: number, length: number) => Promise<Uint8Array>,
  isCancelled: () => boolean,
): Promise<Uint8Array | null> {
  if (
    !Number.isSafeInteger(totalBytes) ||
    totalBytes < 0 ||
    !Number.isSafeInteger(chunkSize) ||
    chunkSize <= 0
  )
    throw new Error("Invalid preview byte range");
  if (isCancelled()) return null;
  // 调用方已经限制小型 PDF 大小；边读边写最终缓冲，不同时保留全部分块和拼接副本。
  const data = new Uint8Array(totalBytes);
  let offset = 0;
  while (offset < totalBytes) {
    if (isCancelled()) return null;
    const length = Math.min(chunkSize, totalBytes - offset);
    const chunk = await readRange(offset, length);
    if (isCancelled()) return null;
    if (chunk.length === 0) break;
    const used = Math.min(chunk.length, length);
    data.set(chunk.subarray(0, used), offset);
    offset += used;
  }
  // 截断文件不把未读尾部暴露给解析器；正常完成时直接返回原缓冲。
  return offset === totalBytes ? data : data.slice(0, offset);
}
