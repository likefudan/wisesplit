// Vite's ?raw imports: the file's text, used to check src/web/public/_headers.
declare module "*?raw" {
  const text: string;
  export default text;
}
