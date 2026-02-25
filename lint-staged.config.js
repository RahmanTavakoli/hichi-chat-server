module.exports = {
  // فرمت‌بندی فایل‌ها (ارسال نام فایل‌ها به Prettier مشکلی ندارد)
  '**/*.{ts,tsx,js,json,md}': ['prettier --write', 'prettier --check'],

  // بررسی تایپ‌ها: استفاده از یک تابع (Arrow Function) باعث می‌شود
  // lint-staged آرایه فایل‌ها را نادیده بگیرد و فقط همین دستور ثابت را اجرا کند
  '**/*.ts': () => 'tsc --project tsconfig.json --noEmit',
};
