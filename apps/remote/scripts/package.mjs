import { packager } from '@electron/packager';
const paths = await packager({
  dir: '.', out: 'release', name: 'Workbench Remote', platform: 'darwin',
  arch: process.env.MAC_ARCH || 'arm64', overwrite: true,
  appBundleId: 'dev.workbench.remote', appCategoryType: 'public.app-category.developer-tools',
  asar: true, prune: true,
  ignore: [/^\/workbench-cli($|\/)/, /^\/src($|\/)/, /^\/tests($|\/)/, /^\/scripts($|\/)/, /^\/test-results($|\/)/, /^\/\.github($|\/)/],
});
console.log(paths.join('\n'));
