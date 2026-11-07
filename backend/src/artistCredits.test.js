// Artist credits -> individual artists (artistCredits.js), for the Artists pages.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { splitArtistCredit, knownArtistKeys, artistNameKey, BANDS } = require('./artistCredits');
const { normalizeArtist, metaKey, META_KEY_VERSION } = require('./songMatch');

const names = (credit, known = []) => {
  const set = new Set(known.map(artistNameKey));
  return splitArtistCredit(credit, (k) => set.has(k)).map((a) => a.name);
};
const keys = (credit, known = []) => {
  const set = new Set(known.map(artistNameKey));
  return splitArtistCredit(credit, (k) => set.has(k)).map((a) => a.key);
};

describe('artistCredits: artistNameKey', () => {
  it('folds, reads & as "and", drops punctuation, spaces and a leading "the"', () => {
    assert.equal(artistNameKey('Barış Manço'), 'barismanco');
    assert.equal(artistNameKey('The Beatles'), 'beatles');
    assert.equal(artistNameKey('Earth, Wind & Fire'), 'earthwindandfire');
    assert.equal(artistNameKey('Earth Wind and Fire'), 'earthwindandfire');
    assert.equal(artistNameKey('K.I.Z'), 'kiz');
    assert.equal(artistNameKey('Кино'), 'кино');
    assert.equal(artistNameKey('---'), '');
    assert.equal(artistNameKey('x'.repeat(300)).length, 200);
  });

  it('is the key normalizeArtist gives a single artist, so old /artist/<key> links keep working', () => {
    for (const a of ['Barış Manço', 'barismanco', 'Tarkan', 'The Beatles', 'Sezen Aksu', 'CEM KARACA', 'Кино', 'Athena', 'Adamlar']) {
      assert.equal(splitArtistCredit(a)[0].key, normalizeArtist(a), a);
    }
    for (const a of ['Barış Manço - Topic', 'TarkanVEVO', 'Duman Official']) {
      assert.equal(splitArtistCredit(a)[0].key, normalizeArtist(a), a);
    }
  });
});

describe('artistCredits: always-split separators', () => {
  it('splits YouTube Music\'s ", " lists', () => {
    assert.deepEqual(names('RAYE, 070 Shake'), ['RAYE', '070 Shake']);
    assert.deepEqual(names('Alicia de Larrocha, Isaac Albéniz'), ['Alicia de Larrocha', 'Isaac Albéniz']);
    assert.deepEqual(names('Big Maceo, Major Maceo Merriweather'), ['Big Maceo', 'Major Maceo Merriweather']);
    assert.deepEqual(names('The Weeknd, Lana Del Rey'), ['The Weeknd', 'Lana Del Rey']);
    assert.deepEqual(names('A,B ,  C'), ['A', 'B', 'C']);
  });

  it('splits the feat family, vs., x, ; and " / "', () => {
    assert.deepEqual(names('Drake feat. Rihanna'), ['Drake', 'Rihanna']);
    assert.deepEqual(names('Drake Feat Rihanna'), ['Drake', 'Rihanna']);
    assert.deepEqual(names('Drake ft. Rihanna'), ['Drake', 'Rihanna']);
    assert.deepEqual(names('Drake ft Rihanna'), ['Drake', 'Rihanna']);
    assert.deepEqual(names('Drake featuring Rihanna, Future'), ['Drake', 'Rihanna', 'Future']);
    assert.deepEqual(names('Daft Punk vs. Kanye West'), ['Daft Punk', 'Kanye West']);
    assert.deepEqual(names('Daft Punk vs Kanye West'), ['Daft Punk', 'Kanye West']);
    assert.deepEqual(names('Rihanna x Drake'), ['Rihanna', 'Drake']);
    assert.deepEqual(names('Rihanna × Drake'), ['Rihanna', 'Drake']);
    assert.deepEqual(names('Sezen Aksu; Tarkan'), ['Sezen Aksu', 'Tarkan']);
    assert.deepEqual(names('Ahmet Kaya / Sezen Aksu'), ['Ahmet Kaya', 'Sezen Aksu']);
  });

  it('bracketed credits become artists; other brackets leave the name', () => {
    assert.deepEqual(names('Calvin Harris (feat. Rihanna)'), ['Calvin Harris', 'Rihanna']);
    assert.deepEqual(names('Calvin Harris [ft. Rihanna, Future]'), ['Calvin Harris', 'Rihanna', 'Future']);
    assert.deepEqual(names('Calvin Harris (with Dua Lipa)'), ['Calvin Harris', 'Dua Lipa']);
    assert.deepEqual(names('Sezen Aksu (Official)'), ['Sezen Aksu']);
  });

  it('a capital X, "x" inside a word or a name ending in X is no separator', () => {
    assert.deepEqual(names('Lil Nas X'), ['Lil Nas X']);
    assert.deepEqual(names('Malcolm X Band'), ['Malcolm X Band']);
    assert.deepEqual(names('lil nas x, Billy Ray Cyrus'), ['lil nas x', 'Billy Ray Cyrus']);
    assert.deepEqual(names('X Ambassadors'), ['X Ambassadors']);
    assert.deepEqual(names('AC/DC'), ['AC/DC']);
    assert.deepEqual(names('Florence + the Machine'), ['Florence + the Machine']);
  });

  it('drops channel suffixes on the credit and on each artist', () => {
    assert.deepEqual(names('Barış Manço - Topic'), ['Barış Manço']);
    assert.deepEqual(names('TarkanVEVO'), ['Tarkan']);
    assert.deepEqual(names('Duman Official'), ['Duman']);
    assert.deepEqual(names('AdeleVEVO, Sezen Aksu - Topic'), ['Adele', 'Sezen Aksu']);
  });

  it('one entry per artist, in credit order; nothing for an empty credit', () => {
    assert.deepEqual(names('RAYE, raye, RAYE feat. 070 Shake'), ['RAYE', '070 Shake']);
    assert.deepEqual(names(''), []);
    assert.deepEqual(names('---'), []);
    assert.deepEqual(names(null), []);
    assert.deepEqual(names(', ,'), []);
  });
});

describe('artistCredits: band names', () => {
  it('names in BANDS survive however they are written', () => {
    assert.deepEqual(names('Earth, Wind & Fire'), ['Earth, Wind & Fire']);
    assert.deepEqual(names('Earth Wind and Fire'), ['Earth Wind and Fire']);
    assert.deepEqual(names('Tyler, The Creator'), ['Tyler, The Creator']);
    assert.deepEqual(names('Crosby, Stills, Nash & Young'), ['Crosby, Stills, Nash & Young']);
    assert.deepEqual(names('Crosby, Stills & Nash'), ['Crosby, Stills & Nash']);
    assert.deepEqual(names('Simon & Garfunkel', ['Simon', 'Garfunkel']), ['Simon & Garfunkel']);
    assert.deepEqual(names('Simon and Garfunkel'), ['Simon and Garfunkel']);
    assert.deepEqual(names('Ike & Tina Turner', ['Tina Turner']), ['Ike & Tina Turner']);
    assert.deepEqual(names('Mor ve Ötesi'), ['Mor ve Ötesi']);
    for (const band of BANDS) assert.deepEqual(names(band, ['Earth', 'Tyler', 'Simon', 'Tina Turner', 'Mor']), [band], band);
  });

  it('a band inside a longer credit is one of its artists', () => {
    assert.deepEqual(names('Earth, Wind & Fire, The Emotions'), ['Earth, Wind & Fire', 'The Emotions']);
    assert.deepEqual(names('Tyler, The Creator, Kali Uchis'), ['Tyler, The Creator', 'Kali Uchis']);
    assert.deepEqual(names('Kali Uchis feat. Tyler, The Creator'), ['Kali Uchis', 'Tyler, The Creator']);
    assert.deepEqual(names('Mor ve Ötesi & Sezen Aksu', ['Sezen Aksu']), ['Mor ve Ötesi', 'Sezen Aksu']);
  });

  it('"X & the Ys", "X And His Orchestra", "X & Sons" are one band', () => {
    const known = ['Bob Marley', 'Kool', 'Buddy Johnson', 'Mumford', 'Edip Akbayram'];
    assert.deepEqual(names('Bob Marley & The Wailers', known), ['Bob Marley & The Wailers']);
    assert.deepEqual(names('Kool & the Gang', known), ['Kool & the Gang']);
    assert.deepEqual(names('Buddy Johnson And His Orchestra', known), ['Buddy Johnson And His Orchestra']);
    assert.deepEqual(names('Mumford & Sons', known), ['Mumford & Sons']);
    assert.deepEqual(names('Edip Akbayram & Dostlar', known), ['Edip Akbayram & Dostlar']);
    assert.deepEqual(names('Florence and the Machine'), ['Florence and the Machine']);
  });
});

describe('artistCredits: "&", "and", "ve" split only next to a known artist', () => {
  it('splits when either side is known', () => {
    assert.deepEqual(names('AnnenMayKantereit & K.I.Z', ['AnnenMayKantereit']), ['AnnenMayKantereit', 'K.I.Z']);
    assert.deepEqual(names('AnnenMayKantereit & K.I.Z', ['K.I.Z']), ['AnnenMayKantereit', 'K.I.Z']);
    assert.deepEqual(names('Barış Manço & Kurtalan Ekspres', ['Barış Manço']), ['Barış Manço', 'Kurtalan Ekspres']);
    assert.deepEqual(names('Lady Gaga and Bradley Cooper', ['Lady Gaga']), ['Lady Gaga', 'Bradley Cooper']);
    assert.deepEqual(names('Kayahan ve Nilüfer', ['Nilüfer']), ['Kayahan', 'Nilüfer']);
    assert.deepEqual(names('Lil Nas X & Billy Ray Cyrus', ['Billy Ray Cyrus']), ['Lil Nas X', 'Billy Ray Cyrus']);
  });

  it('keeps the credit whole when neither side is known', () => {
    assert.deepEqual(names('Hall & Oates'), ['Hall & Oates']);
    assert.deepEqual(names('Brooks & Dunn'), ['Brooks & Dunn']);
    assert.deepEqual(names('Barış Manço & Kurtalan Ekspres'), ['Barış Manço & Kurtalan Ekspres']);
  });

  it('decides each "&" on its own, after the commas', () => {
    assert.deepEqual(names('A, B & C'), ['A', 'B & C']);
    assert.deepEqual(names('A, B & C', ['C']), ['A', 'B', 'C']);
    assert.deepEqual(names('A & B & C', ['A']), ['A', 'B & C']);
    assert.deepEqual(names('A & B & C', ['B']), ['A', 'B', 'C']);
  });

  it('keys are the individual artists', () => {
    assert.deepEqual(keys('Barış Manço & Kurtalan Ekspres', ['Barış Manço']), ['barismanco', 'kurtalanekspres']);
    assert.deepEqual(keys('Simon & Garfunkel'), ['simonandgarfunkel']);
  });
});

describe('artistCredits: knownArtistKeys', () => {
  it('counts lone credits, the parts of ","/feat lists and BANDS names, never another part holding "&"', () => {
    const known = knownArtistKeys([
      'RAYE, 070 Shake', 'Barış Manço', 'Barış Manço & Kurtalan Ekspres', 'Drake feat. Rihanna',
      'Earth, Wind & Fire', 'Hall & Oates', 'Duman - Topic', 'Calvin Harris (with Dua Lipa)', '',
    ]);
    assert.deepEqual([...known].sort(), [
      '070shake', 'barismanco', 'calvinharris', 'drake', 'dualipa', 'duman', 'earthwindandfire', 'hallandoates', 'raye', 'rihanna',
    ]);
  });

  it('end to end: a library where Barış Manço has songs of his own', () => {
    const credits = ['Barış Manço', 'Barış Manço & Kurtalan Ekspres', 'Simon & Garfunkel', 'Paul Simon'];
    const known = knownArtistKeys(credits);
    const split = (c) => splitArtistCredit(c, (k) => known.has(k)).map((a) => a.name);
    assert.deepEqual(split('Barış Manço & Kurtalan Ekspres'), ['Barış Manço', 'Kurtalan Ekspres']);
    assert.deepEqual(split('Simon & Garfunkel'), ['Simon & Garfunkel']);
  });
});

describe('artistCredits: duplicate detection is untouched', () => {
  it('normalizeArtist and meta keys still use the primary artist only', () => {
    assert.equal(META_KEY_VERSION, 1);
    assert.equal(normalizeArtist('RAYE, 070 Shake'), 'raye');
    assert.equal(normalizeArtist('Simon & Garfunkel'), 'simon');
    assert.equal(metaKey('Escapism.', 'RAYE, 070 Shake'), 'raye|escapism');
  });
});
