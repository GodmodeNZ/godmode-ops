import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { transaction } from '../apps/api/src/core.js';
import { purchasePlan, createPurchaseDrafts } from '../apps/api/src/procurement.js';
const db = new PrismaClient();
try {
 if (process.argv.includes('--create-pos')) console.log(JSON.stringify(await transaction(db, createPurchaseDrafts), null, 2));
 else console.log(JSON.stringify(await purchasePlan(db), null, 2));
} finally { await db.$disconnect(); }
