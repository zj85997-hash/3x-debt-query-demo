export function normalizeCandidatePair(name, tail4) {
  const sampleName = typeof name==='string' ? name.normalize('NFKC').trim() : '';
  const suffix = typeof tail4==='string' ? tail4.normalize('NFKC').trim().toUpperCase() : '';
  if (!/^样例(?:[\p{Script=Han}]{1,8}|\*\d{5})$/u.test(sampleName) || !/^\d{3}[0-9X]$/.test(suffix)) return null;
  return {sampleName,suffix};
}
