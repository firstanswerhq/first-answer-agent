// Trigger words must not fire inside ordinary words ("client" is not a "lien", "Auditor Lane" is not an audit), and the
// real urgent messages must still escalate. Fixtures per shipped profile.
import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, mustEscalate } from '../src/safety.js';
import { loadProfile } from '../src/profile.js';

const ORDINARY = {
  dental: [
    'Are you taking new patients this month?', 'I am a new patient and need a cleaning', 'How much is a cleaning and checkup?', 'What are your hours on Friday?',
    'Is there parking near the office?', 'Can I book a time for next Tuesday afternoon?', 'My daughter Chester needs a checkup', 'I live on Auditor Lane in Franklin',
    'We are painting our house so mornings are hard for me', 'Do you see kids?', 'I would like to come in tomorrow if possible', 'Do you have anything open this week?',
    'My name is Bill Turner and I need a filling', 'Is a whitening consultation free?', 'I have a little sensitivity when I drink cold water', 'Can I bring my husband to the visit?',
    'Do you do teeth whitening?', 'Is the office wheelchair accessible?', 'How long does a cleaning take?', 'I just moved to Nashville and need a new dentist',
    'Do you accept walk-ins?', 'What should I bring to my first visit?', 'My turnover at work is high so evenings are better', 'I need a cleaning before my wedding',
    'Is there a Saturday option?', 'Do you offer payments by card?', 'Can someone show me the office before I book?', 'My tooth feels a bit rough, can I get it looked at next week?',
    'I need braces consultation for my son', 'We are new in town and looking for a family dentist', 'Do you have an email address I can use?', 'How do I get to the office from the Gulch?',
    'Can I schedule both kids on the same day?', 'I would like the earliest appointment you have', 'Do you have a waiting list?', 'What is the cost of a filling?',
    'Do you remove wisdom teeth or refer out?', 'I am nervous about the dentist, are you gentle?', 'I need a night guard fitted', 'Hello, who will see me at the first visit?',
    'Pain-free options for cleanings?', 'The Chester Street entrance is closed, where do I park?',
  ],
  salon: [
    'Are you taking new clients this month?', 'I am a new client and want a cut and color', 'How much is a balayage?', 'What are your hours on Saturday?', 'Is there parking?',
    'Can I book next Thursday at 2?', 'My friend Chester recommended you', 'I live on Auditor Lane', 'We are painting the house, so Friday morning is best',
    'My name is Bill and I want a trim', 'Do you do kids haircuts?', 'Do you cut curly hair?', 'How long does a highlight take?', 'I would like a blowout for a wedding',
    'Can I bring my daughter along?', 'What products do you use?', 'Do you have an opening tomorrow?', 'I want to go a bit lighter for summer', 'Do you do men\'s cuts?',
    'My hair is shoulder length and I want a bob', 'What does a keratin treatment cost?', 'Do you offer gift cards?', 'Is there a student discount?', 'I just moved here and need a stylist',
    'Do you have a stylist who is good with fine hair?', 'Can I get a quote for bridal party hair?', 'How far ahead should I book?', 'I need a haircut before an interview',
    'My turnover at work is high so evenings are better', 'I have a burning desire for a pixie cut', 'Do you take walk-ins?', 'Can I pay by card?', 'What is the earliest appointment?',
    'I would like to talk about extensions pricing', 'Do you do toner for gray hair?', 'I want a color refresh, not a big change', 'Is the salon wheelchair accessible?',
    'Hello, do you have availability this weekend?', 'My scalp is a little dry in winter, any treatment recommendations?', 'We need hair and makeup for four people', 'Do you have a waiting list?', 'Where do I enter the building?',
  ],
  accounting: [
    'Are you taking new clients this month?', 'I am a new client and need my taxes done', 'How much do you charge for a personal return?', 'What are your hours on Friday?', 'Is there parking near the office?',
    'Can I book a time next Tuesday?', 'I would like a quote for bookkeeping', 'My name is Chester and I run a small shop', 'I live on Auditor Lane in Brentwood', 'We went to an audition last night, sorry for the late message',
    'Do you work with independent contractors?', 'I am a contractor and need help with quarterly taxes', 'My name is Bill Turner', 'Do you offer payroll services?', 'Can you help me set up QuickBooks?',
    'What documents should I bring for my appointment?', 'Do you do business returns for LLCs?', 'I have several clients of my own and need my books cleaned up', 'We are painting the office, so afternoons are better',
    'Do you have anything open this week?', 'Is the first consultation free?', 'How long does a return take?', 'Do you do taxes for people living abroad?', 'I just started a business and need an accountant',
    'Can I upload my documents online?', 'I need help catching up on bookkeeping for last year', 'Do you handle sales tax filings?', 'Do you take walk-ins?', 'What is the cost of monthly bookkeeping?',
    'Are you accepting new small business clients?', 'My turnover this year was about 80k, can you do my return?', 'Is there a Saturday option?', 'My client list is growing and I need a bookkeeper', 'Who will be my accountant?',
    'Can you recommend a good time of day?', 'I need help with my 2025 return', 'I have a question about the filing fee', 'Do you speak Spanish?', 'We are a family of five and need our return done', 'Mr. Levy referred me to you',
    'Can I meet in person?', 'What do you charge per hour?',
  ],
};

const URGENT = {
  dental: ['I have severe pain in my jaw', 'My tooth got knocked out playing ball', 'My face is swollen', 'I think I have an abscess', 'bleeding that will not stop after my extraction', 'I have trouble swallowing and my jaw hurts'],
  salon: ['My scalp is burning after the color', 'I got a chemical burn on my scalp', 'I have blisters after the bleach', 'I am having an allergic reaction to the dye', 'swelling around my eyes since the treatment', 'trouble breathing after the perm'],
  accounting: ['I got an IRS notice and need help', 'There is a levy on my bank account', 'I received a lien notice', 'I got an audit letter from the IRS', 'The IRS is going to garnish my wages', 'I got a letter from the IRS yesterday', 'My filing deadline is tomorrow', 'I am being audited', 'a tax lien was filed against me', 'I have a wage garnishment', 'I received a penalty notice', 'Our taxes are due today'],
};
const HUMAN_BY_DESIGN = {
  dental: ['Do you take Delta Dental insurance?'.replace('Delta Dental insurance', 'insurance')],
  salon: ['I need a color correction after another salon ruined it'],
  accounting: ['Can I deduct my home office?', 'I have an engagement letter question'],
};

for (const name of ['dental', 'salon', 'accounting']) {
  const profile = loadProfile(name);
  test(`[${name}] at least 40 ordinary messages do not escalate`, () => {
    assert.ok(ORDINARY[name].length >= 40);
    for (const m of ORDINARY[name]) {
      const f = classify(m, profile);
      assert.equal(mustEscalate(f), false, `${m} -> ${f.reasons.join('; ')}`);
    }
  });
  test(`[${name}] real urgent messages still escalate`, () => {
    for (const m of URGENT[name]) assert.equal(mustEscalate(classify(m, profile)), true, m);
  });
  test(`[${name}] always-human topics still go to a person`, () => {
    for (const m of HUMAN_BY_DESIGN[name]) assert.equal(mustEscalate(classify(m, profile)), true, m);
  });
}
