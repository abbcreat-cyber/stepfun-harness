import {win32,posix} from 'node:path';

/** 接原生累积器的元数据，不从控制台正文提取或猜测日志文件。 */
export function nativeShellOutputDisplay(toolName,result,text) {
 if (!['powershell','bash','run_command'].includes(toolName) || typeof text!=='string' || text.length>150000) return null;
 const d=result?.details;if(!d || typeof d!=='object' || Array.isArray(d))return null;
 const path=d.fullOutputPath;
 const outputPath=typeof path==='string'&&path.length>0&&path.length<=32768&&(win32.isAbsolute(path)||posix.isAbsolute(path))?path:undefined;
 const truncated=d.truncation?.truncated;
 if(typeof truncated!=='boolean'&&!outputPath)return null;
 return {kind:'bash_output',output:text,truncated:truncated===true,...(outputPath?{outputPath}:{})};
}
