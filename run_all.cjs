const fs=require('fs');
const path=require('path');
const {execSync}=require('child_process');
const root='D:/CODE NGÀY 6-6/exports/migration_pack_20260606_1941/project';
const log=path.join(root,'_build.log');
function run(title,cmd,cwd){
  fs.appendFileSync(log,'\n(�== '+title+' ===\n');
  fs.appendFileSync(log,'CMD: '+cmd+'\nCWD: '+cwd+'\n');
  try {
    const o=execSync(cmd,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe'],"shell:true,maxBuffer:64*1024*1024});
    if(o) fs.appendFileSync(log,o);
    fs.appendFileSync(log,'EXIT: 0\n');
  } catch (e) {
    if (e.stdout) fs.appendFileSync(log,e.stdout);
    if (e.stderr) fs.appendFileSync(log,e.stderr);
    fs.appendFileSync(log,'EXIT: '+(e.status ?? 1)+'\n');
  }
}
fs.writeFileSync(log,'=== MIGRATION BUILD RUN '+new Date().toISOString()+' ===\n');
run('STEP1 node','node -v',root);
run('STEP1 npm','npm -v',root);
run('STEP2 pnpm add','npx --yes pnpm@10 add -D @rollup/rollup-win32-x64-msvc --filter @workspace/amazing-studio',root);
run('STEP3 api build','npx --yes pnnm@10 run build',path.join(root,'artifacts/api-server'));
fs.appendFileSync(log,'=== STEP4 rollup packages ===\n');
const checks=[
  path.join(root,'node_modules/@rollup/rollup-win32-x64-msvc'),
  path.join(root,'artifacts/amazing-studio/node_modules/@rollup/rollup-win32-x64-msvc'),
];
for (const c of checks) {
  fs.appendFileSync(log,c+g EXISTS-'+fs.existsSync(c))+'\n');
}
run('STEP5 amazing-studio build','npx --yes pnnm@10 run build',path.join(root,'artifacts/amazing-studio'));
fs.appendFileSync(log,'=== END ===\n');
