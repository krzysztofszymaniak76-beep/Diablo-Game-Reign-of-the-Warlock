// Legacy log strings may remain in a save. Correct their display, never the save.
export function act1DisplayText(value) {
  return String(value)
    .replace(/Jaskinia [Zz]ła została oczyszczona/g,'Siedlisko Zła zostało oczyszczone')
    .replace(/Jaskinia [Zz]ła oczyszczona/g,'Siedlisko Zła oczyszczone')
    .replace(/w Jaskini [Zz]ła/g,'w Siedlisku Zła')
    .replace(/Jaskinię [Zz]ła/g,'Siedlisko Zła')
    .replace(/Jaskini [Zz]ła/g,'Siedliska Zła')
    .replace(/Jaskinia [Zz]ła/g,'Siedlisko Zła');
}
