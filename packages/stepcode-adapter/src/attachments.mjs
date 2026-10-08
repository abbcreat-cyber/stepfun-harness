import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rm, rename, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
const MAX = 20 * 1024 * 1024,
  CHUNK = 512 * 1024;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const imageTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
function decode(text) {
  if (
    typeof text !== "string" ||
    text.length > Math.ceil(CHUNK / 3) * 4 ||
    text.length % 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)
  )
    throw new Error("图片分块格式无效");
  const bytes = Buffer.from(text, "base64");
  if (bytes.length > CHUNK) throw new Error("图片分块过大");
  return bytes;
}
function assertImage(bytes, mime) {
  const valid =
    mime === "image/png"
      ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : mime === "image/jpeg"
        ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
        : mime === "image/gif"
          ? /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString())
          : mime === "image/webp"
            ? bytes.subarray(0, 4).toString() === "RIFF" &&
              bytes.subarray(8, 12).toString() === "WEBP"
            : false;
  if (!valid) throw new Error("图片内容与格式不符，请重新粘贴");
}
export class AttachmentStore {
  constructor(root) {
    this.root = root;
    this.uploads = new Map();
    this.commits = new Map();
  }
  key(p) {
    if (!p.sessionId || !p.connectionId || !p.uploadId) throw new Error("附件事务缺少身份");
    return hash(JSON.stringify([p.sessionId, p.connectionId, p.uploadId]));
  }
  directory(sessionId) {
    return join(this.root, hash(sessionId));
  }
  async metadata(sessionId, id) {
    try {
      return JSON.parse(await readFile(join(this.directory(sessionId), `${id}.json`), "utf8"));
    } catch (e) {
      if (e.code === "ENOENT") return null;
      throw e;
    }
  }
  async begin(p) {
    const key = this.key(p);
    if (!imageTypes.has(p.mime)) throw new Error("当前图片上传支持 PNG、JPEG、WebP 和 GIF");
    if (
      !Number.isInteger(p.totalBytes) ||
      p.totalBytes < 1 ||
      p.totalBytes > MAX ||
      !Number.isInteger(p.totalChunks) ||
      p.totalChunks < 1 ||
      p.totalChunks > 64 ||
      !/^sha256:[a-f0-9]{64}$/.test(p.checksum) ||
      typeof p.fileName !== "string" ||
      p.fileName.length > 255
    )
      throw new Error("图片上传声明无效或超过20MB");
    const signature = JSON.stringify([p.fileName, p.mime, p.totalBytes, p.totalChunks, p.checksum]);
    const saved = await this.metadata(p.sessionId, key),
      pending = this.uploads.get(key);
    if ((saved && saved.signature !== signature) || (pending && pending.signature !== signature))
      throw new Error("附件事务内容发生变化，请重新上传");
    if (saved)
      return {
        uploadId: p.uploadId,
        state: "committed",
        nextChunkIndex: p.totalChunks,
        ref: `step-attachment:${key}`,
      };
    if (!pending) {
      if (this.uploads.size >= 16) throw new Error("同时上传的图片过多，请稍后重试");
      this.uploads.set(key, { ...p, signature, chunks: [], bytes: 0 });
    }
    return {
      uploadId: p.uploadId,
      state: "staging",
      nextChunkIndex: this.uploads.get(key).chunks.length,
    };
  }
  chunk(p) {
    const upload = this.uploads.get(this.key(p));
    if (!upload) throw new Error("上传已失效，请重试");
    const bytes = decode(p.dataBase64);
    if (!Number.isInteger(p.chunkIndex) || p.chunkIndex < 0 || p.chunkIndex > upload.chunks.length)
      throw new Error("图片分块顺序错误");
    if (p.chunkIndex < upload.chunks.length) {
      if (!bytes.equals(upload.chunks[p.chunkIndex])) throw new Error("重复分块内容不一致");
    } else {
      if (
        upload.chunks.length >= upload.totalChunks ||
        upload.bytes + bytes.length > upload.totalBytes
      )
        throw new Error("图片大小与声明不符");
      upload.chunks.push(bytes);
      upload.bytes += bytes.length;
    }
    return { uploadId: p.uploadId, nextChunkIndex: upload.chunks.length };
  }
  async commit(p) {
    const key=this.key(p);
    if(this.commits.has(key))return this.commits.get(key);
    const promise=this.commitOne(p);this.commits.set(key,promise);
    try{return await promise;}finally{this.commits.delete(key);}
  }
  async commitOne(p) {
    const key = this.key(p),
      upload = this.uploads.get(key),
      saved = await this.metadata(p.sessionId, key);
    if (saved) return { ref: `step-attachment:${key}` };
    if (!upload) throw new Error("上传已失效，请重试");
    if (upload.chunks.length !== upload.totalChunks || upload.bytes !== upload.totalBytes)
      throw new Error("图片尚未上传完整");
    const bytes = Buffer.concat(upload.chunks);
    if (`sha256:${hash(bytes)}` !== upload.checksum) throw new Error("图片校验失败，请重试");
    assertImage(bytes, upload.mime);
    const dir = this.directory(p.sessionId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${key}.bin`), bytes);
    const meta = {
      signature: upload.signature,
      mime: upload.mime,
      fileName: upload.fileName,
      bytes: bytes.length,
    };
    const temp = join(dir, `${key}.${process.pid}.tmp`);
    await writeFile(temp, JSON.stringify(meta));
    await rename(temp, join(dir, `${key}.json`));
    this.uploads.delete(key);
    return { ref: `step-attachment:${key}` };
  }
  abort(p) {
    this.uploads.delete(this.key(p));
    return {};
  }
  /**
   * 把某会话的附件目录整体搬迁到 targetDir（P1-01 deleteSession 的 trash 归档消费：
   * 归档而不是物理删除——误删可从 trash 恢复）。rename 目录跨卷会 EXDEV，此时降级
   * cp 复制后 rm 原目录；源目录不存在（ENOENT）原样上抛——由调用方统一容忍「该会话
   * 从未有过附件」的空态；其余失败如实上抛（调用方据此让删除整体失败并保持可重试）。
   * @param {string} sessionId
   * @param {string} targetDir 目标目录绝对路径（父目录须已存在）。
   */
  async relocateSession(sessionId, targetDir) {
    const source = this.directory(sessionId);
    await mkdir(dirname(targetDir), { recursive: true });
    try {
      await rename(source, targetDir);
    } catch (error) {
      if (error.code === "EXDEV") {
        await cp(source, targetDir, { recursive: true });
        await rm(source, { recursive: true, force: true });
        return targetDir;
      }
      throw error;
    }
    return targetDir;
  }
  async resolve(sessionId, attachment) {
    let bytes,
      mime = attachment.mime;
    if (/^step-attachment:[a-f0-9]{64}$/.test(attachment.ref)) {
      const id = attachment.ref.slice(16),
        meta = await this.metadata(sessionId, id);
      if (!meta) throw new Error("找不到当前会话的已提交图片");
      mime = meta.mime;
      bytes = await readFile(join(this.directory(sessionId), `${id}.bin`));
    } else if (isAbsolute(attachment.ref)) {
      if ((await stat(attachment.ref)).size > MAX) throw new Error("图片超过20MB");
      bytes = await readFile(attachment.ref);
    } else throw new Error("图片附件引用无效");
    if (bytes.length > MAX) throw new Error("图片超过20MB");
    assertImage(bytes, mime);
    return { bytes, mime };
  }
  async images(sessionId, attachments = []) {
    if (!Array.isArray(attachments) || attachments.length > 20) throw new Error("图片附件数量无效");
    const images = [];
    for (const attachment of attachments) {
      const { bytes, mime } = await this.resolve(sessionId, attachment);
      images.push({ type: "image", data: bytes.toString("base64"), mimeType: mime });
    }
    return images;
  }
  async read(p, rows) {
    const row = rows.find(
      (r) =>
        r.kind === "userInput" &&
        (!p.target || r.rowId === p.target.rowId) &&
        r.attachments?.some(
          (a, i) => a.ref === p.ref && (p.attachmentIndex === undefined || i === p.attachmentIndex),
        ),
    );
    if (!row) throw new Error("该图片不属于当前会话消息");
    if (
      !Number.isInteger(p.offset) ||
      p.offset < 0 ||
      !Number.isInteger(p.limit) ||
      p.limit < 1 ||
      p.limit > CHUNK
    )
      throw new Error("图片读取范围无效");
    const attachment = row.attachments.find((a) => a.ref === p.ref),
      { bytes, mime } = await this.resolve(p.sessionId, attachment),
      end = Math.min(bytes.length, p.offset + p.limit);
    return {
      dataBase64: bytes.subarray(p.offset, end).toString("base64"),
      mediaType: mime,
      totalBytes: bytes.length,
      nextOffset: end < bytes.length ? end : null,
    };
  }
}
