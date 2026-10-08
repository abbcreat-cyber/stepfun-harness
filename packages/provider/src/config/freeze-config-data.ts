/** 配置对象不保留调用方引用；嵌套 JSON 同样属于不可变快照。 */
export function freezeConfigData<T>(input: T): T {
  const cloned = structuredClone(input);
  const freeze = (value: unknown) => {
    if (value && typeof value === "object") {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
  };
  freeze(cloned);
  return cloned;
}
