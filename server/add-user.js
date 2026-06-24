// CLI управления учётками заказчика (web.db).
//   node server/add-user.js <логин> <пароль> [роль]   — создать/обновить (роль: viewer|admin)
//   node server/add-user.js --list                     — список учёток
//   node server/add-user.js --delete <логин>           — удалить
// Пароль в аргументах виден в истории shell — для боевых учёток меняйте его
// и чистите историю, либо заводите учётки на доверенной машине.
import { openWebDb } from './db.js';
import { hashPassword } from './auth.js';

function usage() {
  console.log([
    'Управление учётками веб-карты:',
    '  node server/add-user.js <логин> <пароль> [viewer|admin]',
    '  node server/add-user.js --list',
    '  node server/add-user.js --delete <логин>',
  ].join('\n'));
}

const args = process.argv.slice(2);
const db = openWebDb();

try {
  if (args[0] === '--list') {
    const users = db.listUsers();
    if (!users.length) console.log('Учёток нет.');
    for (const u of users) console.log(`${u.username}\t${u.role}\t${u.created_at}`);
  } else if (args[0] === '--delete') {
    const name = args[1];
    if (!name) { usage(); process.exit(2); }
    console.log(db.deleteUser(name) ? `Удалён: ${name}` : `Не найден: ${name}`);
  } else if (args.length >= 2 && !args[0].startsWith('--')) {
    const [username, password, role = 'viewer'] = args;
    if (!['viewer', 'admin'].includes(role)) {
      console.error(`Роль должна быть viewer или admin, получено: ${role}`);
      process.exit(2);
    }
    if (password.length < 6) {
      console.error('Пароль слишком короткий (минимум 6 символов).');
      process.exit(2);
    }
    db.upsertUser(username, hashPassword(password), role);
    console.log(`Сохранён пользователь: ${username} (${role})`);
  } else {
    usage();
    process.exit(2);
  }
} finally {
  db.close();
}
