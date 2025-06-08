
const padToTwo = (num:number) => {
	return num.toString().padStart(2, '0');
}

export const getTimestampFromDate = (date: Date): string => {
	return (
		[
			date.getFullYear(),
			padToTwo(date.getMonth() + 1),
			padToTwo(date.getDate()),
		].join('-') +
		' ' +
		[
			padToTwo(date.getHours()),
			padToTwo(date.getMinutes()),
			padToTwo(date.getSeconds()),
		].join(':')
	);
}

export const firstToUpper = (str: string) =>	`${str.charAt(0).toUpperCase()}${str.slice(1)}`
