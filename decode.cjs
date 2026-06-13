const fs=require(String.fromCharCode(102,115));
const a=process.argv;
fs.writeFileSync(a[2], Buffer.from(a[3], String.fromCharCode(98,97,115,101,54,52)));
