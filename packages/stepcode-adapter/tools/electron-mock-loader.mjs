/**
 * electron 模块的 ESM loader mock：非 Electron 进程里 import "electron" 会因
 * npm electron 包只导出可执行路径而失败；stepcode-switch-check.mts 用它把
 * "electron" 解析为 app.isPackaged=false 的最小 stub，从而能加载 desktop main
 * 的 stepcodeBackend.ts 做行为验证。
 *
 * Derives from zai-org/ZCode (https://github.com/zai-org/ZCode), Apache-2.0.
 */
const electronMockUrl = "data:text/javascript,export const app = { isPackaged: false, getPath: () => 'C:/tmp' };export default {};";

export async function resolve(specifier, context, next) {
	if (specifier === "electron") {
		return { url: electronMockUrl, shortCircuit: true };
	}
	return next(specifier, context);
}
