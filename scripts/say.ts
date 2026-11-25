/** Every line an operator reads is printed in English and Simplified Chinese. */
export const both = (en: string, zh: string): string => `${en} · ${zh}`;
export const say = (en: string, zh: string): void => console.log(both(en, zh));
