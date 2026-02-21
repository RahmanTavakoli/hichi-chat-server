module.exports = {
  '**/*.{ts,tsx,js,json,md}': ['prettier --write', 'prettier --check'],
  '**/*.ts': ['tsc --noEmit --skipLibCheck'],
};