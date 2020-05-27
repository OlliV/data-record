import { join as pathJoin } from 'path';
import { spawn } from 'child_process';
import tmp from 'tmp-promise';
import { compile, generateCHeader, deserialize } from '../src';
import {unlinkSync} from 'fs';

const tmpFiles: string[] = [];

async function cc(code: string): Promise<string> {
	const tmpFile = await tmp.tmpName({ tmpdir: __dirname, template: pathJoin(__dirname, `tmp-XXXXXX`) });
	tmpFiles.push(tmpFile);

	return new Promise((resolve, reject) => {
		const cc = spawn('gcc', ['-xc', '-', '-o', tmpFile]);

		cc.stdin.end(code);
		cc.stderr.on('data', (data: Buffer) => {
			const str = data.toString('utf8');

			if (!str.includes('#pragma')) {
				console.error(data.toString('utf8'));
			}
		});
		cc.on('close', (code) => {
			if (code !== 0) {
				return reject(`gcc failed with: ${code}`);
			}
			resolve(tmpFile);
		});
	});
}

function runBin(bin: string): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		let out = '';

		const prg = spawn(bin);

		prg.stdout.on('data', (data: Buffer) => {
			out += data.toString('utf8')
		});
		prg.on('close', (code) => {
			if (code !== 0) {
				return reject('Failed');
			}
			resolve(Buffer.from(out, 'hex'));
		});
	});
}

afterAll(() => {
	for (const path of tmpFiles) {
		try {
			unlinkSync(path);
		} catch (err) { }
	}
});

test('Generates a C header that compiles and produces correct output', async () => {
	const def = [
		{ name: 'a', type: 'int8' },
		{ name: 'b', type: 'int8' },
		{ name: 'c', type: 'uint32_be' },
		{ name: 'd', type: 'uint32_be' },
		{ name: 'e', type: 'int8' },
		{ name: 'f', type: 'uint64_be' },
		{ name: 'str', type: 'cstring', size: 10 },
		{ name: 'str_a', type: 'cstring_p' },
		{ name: 'str_b', type: 'cstring_p' },
	];
	const compiled = compile(def, { align: true });
	const cHeader = generateCHeader(compiled, 'my_record');

	const code = `
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
${cHeader}

char hello_en[] = "Hello world!";
char hello_it[] = "Ciao a tutti!";

int main(void)
{
	const size_t struct_len = sizeof(struct my_record)
		+ MY_RECORD_ALIGN(sizeof(hello_it))
		+ MY_RECORD_ALIGN(sizeof(hello_en));
	struct my_record * record = calloc(1, struct_len);

	*record = ((struct my_record){
		.a = 0x1,
		.b = 0x2,
		.c = 0xffffffff,
		.d = 0xffffffff,
		.e = 254,
		.f = 0xffffffffffffffff,
		.str = "QWERTYUI",
		.str_a = hello_en,
		.str_a_len = sizeof(hello_en),
		.str_b = hello_it,
		.str_b_len = sizeof(hello_it),
	});
	my_record_hton(record);
	memcpy(MY_RECORD_POINTER(record, str_a), hello_en, sizeof(hello_en));
	memcpy(MY_RECORD_POINTER(record, str_b), hello_it, sizeof(hello_it));

	for (int i = 0; i < struct_len; i++) {
		printf("%02x", ((unsigned char *)record)[i]);
	}

	return 0;
}
`;

	const bin = await cc(code);
	const buf = await runBin(bin);
	const obj = deserialize(compiled, buf);
	const expected = {
		a: 1,
		b: 2,
		c: 4294967295,
		d: 4294967295,
		e: -2,
		f: BigInt("18446744073709551615"),
		str: 'QWERTYUI',
		str_a: 'Hello world!',
		str_b: 'Ciao a tutti!'
	};

	expect(obj).toEqual(expected);
});
